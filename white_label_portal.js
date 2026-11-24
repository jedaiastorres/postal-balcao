"use strict";

const path=require("node:path");
const crypto=require("node:crypto");
const wlDb=require("./white_label_tenant_db");
const logic=require("./white_label_tenant");

function register({app,db,requireAuth,requireRole,signSession,verifySession,
                   parseCookies,hashPassword,verifyPassword,checkLoginRate,
                   recordLoginFailure,clearLoginFailures,audit}){
  const pool=db.pool;
  const text=value=>String(value??"").trim();
  const carrierCode=value=>text(value).toUpperCase();
  const validCode=value=>/^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(carrierCode(value));
  const safeId=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(value));
  const safeError=(res,error,message)=>{
    if(error.status) return res.status(error.status).json({error:error.message});
    if(error.code==="23505")return res.status(409).json({error:"Este e-mail já está cadastrado."});
    console.error("WL_REQUEST_ERROR",error.code||error.name);
    return res.status(503).json({error:message});
  };
  const maskAccount=account=>({id:account.id,name:account.name,email:account.email,
    role:account.role,pointId:account.point_id||null,active:account.active,mustChangePassword:account.must_change_password});
  const cookie=(token,maxAge)=>"wl_session="+encodeURIComponent(token)+
    "; HttpOnly; SameSite=Lax; Path=/api/wl; Max-Age="+maxAge+
    (process.env.NODE_ENV==="production"?"; Secure":"");
  const rateMap=new Map();
  const publicLimiter=(req,res,next)=>{
    const key=String(req.ip||"unknown").slice(0,100);
    const now=Date.now();
    const prev=rateMap.get(key);
    const item=!prev||now-prev.start>60000?{start:now,count:0}:prev;
    item.count++;
    rateMap.set(key,item);
    if(rateMap.size>5000) rateMap.clear();
    if(item.count>45)return res.status(429).json({error:"Limite de consultas excedido. Tente novamente."});
    next();
  };
  async function authenticate(req,res,next){
    const session=verifySession(parseCookies(req).wl_session);
    if(!session||session.aud!=="white-label"||!safeId(session.carrierId)||!safeId(session.accountId))
      return res.status(401).json({error:"Acesso White Label expirado. Entre novamente."});
    try {
      const [account,carrier]=await Promise.all([
        wlDb.accountById(pool,session.accountId),
        wlDb.carrierById(pool,session.carrierId)
      ]);
      if(!account||!account.active||!carrier||carrier.status!=="DRAFT"||
         account.carrier_id!==carrier.id||session.role!==account.role||
         Number(session.version)!==Number(account.session_version)||
         (account.role==="WL_OPERATOR"&&!account.point_id))
        return res.status(403).json({error:"Este acesso foi alterado ou desativado."});
      if(["POST","PUT","PATCH","DELETE"].includes(req.method)){
        const value=text(req.get("x-csrf-token")),expected=text(session.csrf);
        const a=Buffer.from(value),b=Buffer.from(expected);
        if(!value||a.length!==b.length||!crypto.timingSafeEqual(a,b))
          return res.status(403).json({error:"Proteção da sessão inválida. Atualize o painel."});
      }
      req.wl={carrier,account};
      return next();
    } catch(error){return safeError(res,error,"Não foi possível validar o acesso White Label.");}
  }
  function wlMaster(req,res,next){
    if(req.wl?.account?.role!=="WL_MASTER")return res.status(403).json({error:"Apenas o MASTER desta transportadora pode realizar esta ação."});
    return next();
  }
  function blockNewUsersUntilPasswordChanged(req,res,next){
    if(req.wl.account.must_change_password)return res.status(403).json({error:"Troque a senha temporária antes de configurar sua transportadora."});
    next();
  }

  // Apenas MASTER Postal pode emitir/resetar o primeiro acesso. Nunca criar
  // credenciais automaticamente no cadastro comercial.
  app.post("/api/admin/white-label-carriers/:id/provision",
    requireAuth,requireRole("ADMIN"),async(req,res)=>{
    try{
      if(!safeId(req.params.id))return res.status(400).json({error:"Identificador inválido."});
      const carrier=await wlDb.carrierById(pool,req.params.id);
      if(!carrier)return res.status(404).json({error:"Transportadora não encontrada."});
      if(carrier.status!=="DRAFT")return res.status(409).json({error:"Cadastro indisponível."});
      const temporaryPassword="Wl@"+crypto.randomBytes(12).toString("base64url");
      const account=await wlDb.provisionMaster(pool,carrier,hashPassword(temporaryPassword));
      await audit(req,"WL_PROVISION_MASTER","WHITE_LABEL_CARRIER",carrier.id,{accountId:account.id});
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,loginUrl:"/wl/"+encodeURIComponent(carrier.code),
        email:account.email,temporaryPassword,mustChangePassword:true,
        note:"Copie a senha agora. Este valor não poderá ser consultado novamente."});
    }catch(error){safeError(res,error,"Não foi possível preparar o acesso da transportadora.");}
  });

  app.get("/wl/:code",async(req,res)=>{
    if(!validCode(req.params.code))return res.status(404).send("Transportadora não encontrada.");
    try{
      const carrier=await wlDb.carrierByCode(pool,carrierCode(req.params.code));
      if(!carrier||carrier.status!=="DRAFT")return res.status(404).send("Transportadora não encontrada.");
      res.setHeader("Cache-Control","private,no-store");
      res.sendFile(path.join(__dirname,"public","white-label.html"));
    }catch(error){res.status(503).send("Portal temporariamente indisponível.");}
  });

  app.get("/api/wl/public/:code",publicLimiter,async(req,res)=>{
    if(!validCode(req.params.code))return res.status(404).json({error:"Empresa não encontrada."});
    try {
      const carrier=await wlDb.carrierByCode(pool,carrierCode(req.params.code));
      if(!carrier||carrier.status!=="DRAFT")return res.status(404).json({error:"Empresa não encontrada."});
      res.setHeader("Cache-Control","no-store");
      res.json({brand:logic.publicBrand(carrier)});
    }catch(error){safeError(res,error,"Não foi possível consultar a empresa.");}
  });
  app.post("/api/wl/login",async(req,res)=>{
    const email=text(req.body?.email).toLowerCase();
    const code=carrierCode(req.body?.code);
    const password=String(req.body?.password||"");
    if(!validCode(code)||!/^\S+@\S+\.\S+$/.test(email))
      return res.status(401).json({error:"Credenciais inválidas."});
    const rate=checkLoginRate(req,"wl:"+code+":"+email);
    if(!rate.ok)return res.status(429).json({error:"Muitas tentativas. Tente novamente mais tarde."});
    try {
      const [account,carrier]=await Promise.all([
        wlDb.accountByEmail(pool,email),wlDb.carrierByCode(pool,code)
      ]);
      if(!account||!carrier||carrier.status!=="DRAFT"||!account.active||
         account.carrier_id!==carrier.id||!verifyPassword(password,account.password_hash)){
        recordLoginFailure(rate.key);
        return res.status(401).json({error:"Credenciais inválidas."});
      }
      clearLoginFailures(rate.key);
      await pool.query("UPDATE wl_accounts SET last_login_at=NOW() WHERE id=$1 AND carrier_id=$2",[account.id,carrier.id]);
      const csrf=crypto.randomBytes(24).toString("base64url");
      const token=signSession({
        aud:"white-label",accountId:account.id,carrierId:carrier.id,role:account.role,
        version:Number(account.session_version),csrf,exp:Date.now()+6*60*60*1000
      });
      res.setHeader("Set-Cookie",cookie(token,21600));
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,csrf,account:maskAccount(account),brand:logic.publicBrand(carrier)});
    }catch(error){safeError(res,error,"Não foi possível acessar o painel.");}
  });
  app.post("/api/wl/logout",(_req,res)=>{
    res.setHeader("Set-Cookie",cookie("",0));
    res.json({ok:true});
  });
  app.get("/api/wl/session",authenticate,(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,csrf:verifySession(parseCookies(req).wl_session).csrf,
      account:maskAccount(req.wl.account),brand:logic.publicBrand(req.wl.carrier),
      finance:{walletConfigured:Boolean(req.wl.carrier.asaas_wallet_id),paymentsEnabled:false,
               reason:"Operação e split Asaas aguardam homologação."}});
  });
  app.post("/api/wl/password",authenticate,async(req,res)=>{
    const current=String(req.body?.currentPassword||"");
    const next=String(req.body?.nextPassword||"");
    if(next.length<12||next.length>128||!/[^a-zA-Z0-9]/.test(next)||!/[A-Z]/.test(next)||!/[0-9]/.test(next))
      return res.status(400).json({error:"Senha deve ter 12+ caracteres, maiúscula, número e símbolo."});
    if(current===next||!verifyPassword(current,req.wl.account.password_hash))
      return res.status(400).json({error:"Senha atual incorreta ou nova senha repetida."});
    try{
      await wlDb.updatePassword(pool,req.wl.carrier.id,req.wl.account.id,hashPassword(next));
      res.setHeader("Set-Cookie",cookie("",0));
      res.json({ok:true,reloginRequired:true});
    }catch(error){safeError(res,error,"Não foi possível alterar a senha.");}
  });

  app.patch("/api/wl/brand",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    try{
      const brand=logic.normalizeBrand(req.body);
      const updated=await wlDb.updateBrand(pool,req.wl.carrier.id,brand);
      if(!updated)return res.status(409).json({error:"Cadastro indisponível."});
      res.json({ok:true,brand:logic.publicBrand(updated)});
    }catch(error){safeError(res,error,"Não foi possível atualizar a identidade comercial.");}
  });

  app.get("/api/wl/points",authenticate,async(req,res)=>{
    try{
      const points=await wlDb.listPoints(pool,req.wl.carrier.id,
        req.wl.account.role==="WL_OPERATOR"?req.wl.account.point_id:null);
      res.setHeader("Cache-Control","no-store");
      res.json({points:points.map(p=>({
        id:p.id,code:p.code,name:p.name,cep:p.cep,city:p.city,state:p.state,
        address:p.address,number:p.number,active:p.active
      }))});
    }catch(error){safeError(res,error,"Não foi possível consultar as unidades.");}
  });
  app.post("/api/wl/points",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    try{
      const current=await wlDb.listPoints(pool,req.wl.carrier.id);
      if(current.length>=100)return res.status(409).json({error:"Limite de 100 pontos por transportadora."});
      const point=logic.normalizePoint(req.body);
      const created=await wlDb.savePoint(pool,req.wl.carrier.id,point);
      res.status(201).json({ok:true,id:created.id});
    }catch(error){safeError(res,error,"Não foi possível cadastrar a unidade.");}
  });
  app.put("/api/wl/points/:id",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Identificador inválido."});
    try{
      const point=logic.normalizePoint(req.body);
      const updated=await wlDb.savePoint(pool,req.wl.carrier.id,point,req.params.id);
      if(!updated)return res.status(404).json({error:"Unidade não encontrada nesta transportadora."});
      res.json({ok:true,id:updated.id});
    }catch(error){safeError(res,error,"Não foi possível atualizar a unidade.");}
  });

  app.get("/api/wl/routes",authenticate,async(req,res)=>{
    try{
      const rows=await wlDb.listTariffs(pool,req.wl.carrier.id);
      res.setHeader("Cache-Control","no-store");
      res.json({routes:rows.map(x=>({
        id:x.id,name:x.name,originStart:x.origin_start,originEnd:x.origin_end,
        destinationStart:x.destination_start,destinationEnd:x.destination_end,
        minWeight:x.min_weight,maxWeight:x.max_weight,
        price:Number(x.price),perKg:Number(x.per_kg),days:Number(x.days),active:x.active
      })),shippingEnabled:false});
    }catch(error){safeError(res,error,"Não foi possível consultar as rotas.");}
  });
  app.post("/api/wl/routes",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    try{
      const current=await wlDb.listTariffs(pool,req.wl.carrier.id);
      if(current.length>=200)return res.status(409).json({error:"Limite de 200 tarifas por transportadora."});
      const rate=logic.normalizeTariff(req.body);
      const created=await wlDb.saveTariff(pool,req.wl.carrier.id,req.wl.account.id,rate);
      res.status(201).json({ok:true,id:created.id,shippingEnabled:false});
    }catch(error){safeError(res,error,"Não foi possível cadastrar a rota.");}
  });
  app.put("/api/wl/routes/:id",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Identificador de rota inválido."});
    try{
      const rate=logic.normalizeTariff(req.body);
      const updated=await wlDb.saveTariff(pool,req.wl.carrier.id,req.wl.account.id,rate,req.params.id);
      if(!updated)return res.status(404).json({error:"Rota não encontrada nesta transportadora."});
      res.json({ok:true,id:updated.id,shippingEnabled:false});
    }catch(error){safeError(res,error,"Não foi possível atualizar a rota.");}
  });
  app.get("/api/wl/quote",authenticate,async(req,res)=>{
    try{
      const args=logic.validateQuote(req.query);
      const rows=await wlDb.quoteTariffs(pool,req.wl.carrier.id,args);
      const options=rows.map(rate=>logic.pricedTariff(rate,req.wl.carrier,args.weight)).filter(Boolean);
      res.setHeader("Cache-Control","no-store");
      res.json({brand:logic.publicBrand(req.wl.carrier),simulation:true,paymentsEnabled:false,
        options:options.map(x=>req.wl.account.role==="WL_MASTER"?x:{
          id:x.id,name:x.name,total:x.total,days:x.days,estimated:true})});
    }catch(error){safeError(res,error,"Não foi possível simular a rota.");}
  });

  app.get("/api/wl/users",authenticate,wlMaster,async(req,res)=>{
    try{
      const accounts=await wlDb.listAccounts(pool,req.wl.carrier.id);
      res.json({users:accounts.map(maskAccount)});
    }catch(error){safeError(res,error,"Não foi possível consultar a equipe.");}
  });
  app.post("/api/wl/users",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    try{
      const name=text(req.body?.name),email=text(req.body?.email).toLowerCase(),pointId=text(req.body?.pointId);
      if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||email.length>160)
        return res.status(400).json({error:"Informe nome e e-mail válidos."});
      if(!safeId(pointId))return res.status(400).json({error:"Selecione um ponto da sua transportadora."});
      const existing=await wlDb.listAccounts(pool,req.wl.carrier.id);
      if(existing.length>=30)return res.status(409).json({error:"Limite de 30 usuários por transportadora."});
      const temporaryPassword="Wl@"+crypto.randomBytes(12).toString("base64url");
      const account=await wlDb.createOperator(pool,req.wl.carrier.id,
        {name,email,passwordHash:hashPassword(temporaryPassword),pointId});
      res.setHeader("Cache-Control","no-store");
      res.status(201).json({ok:true,user:maskAccount(account),temporaryPassword,
        note:"Copie a senha agora e entregue ao colaborador por canal seguro."});
    }catch(error){safeError(res,error,"Não foi possível cadastrar o operador.");}
  });
  app.patch("/api/wl/users/:id",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id)||typeof req.body?.active!=="boolean")
      return res.status(400).json({error:"Informe usuário e situação válida."});
    try{
      const user=await wlDb.setOperatorStatus(pool,req.wl.carrier.id,req.params.id,req.body.active);
      if(!user)return res.status(404).json({error:"Colaborador não encontrado nesta transportadora."});
      res.json({ok:true,user:maskAccount(user)});
    }catch(error){safeError(res,error,"Não foi possível alterar o acesso.");}
  });
}
module.exports={register};
