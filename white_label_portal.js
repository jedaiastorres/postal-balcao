"use strict";

const path=require("node:path");
const crypto=require("node:crypto");
const wlDb=require("./white_label_tenant_db");
const logic=require("./white_label_tenant");
const hybrid=require("./white_label_hybrid_quote");
const wlClients=require("./white_label_clients");
const wlClientsDb=require("./white_label_clients_db");
const wlCustomerDb=require("./white_label_customer_db");
const wlCustomer=require("./white_label_customer");
const bulkShipping=require("./bulk_shipping");
const wlCollectionDb=require("./white_label_collection_db");
const wlCollection=require("./white_label_collection");

function register({app,db,requireAuth,requireRole,signSession,verifySession,
                   parseCookies,hashPassword,verifyPassword,checkLoginRate,
                   recordLoginFailure,clearLoginFailures,audit,quoteIntegrated,lookupFiscalDocument}){
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
  const hybridQuoteRate=new Map();
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
      if(account.role==="WL_OPERATOR"){
        const linkedPoint=await wlDb.listPoints(pool,carrier.id,account.point_id);
        if(!linkedPoint[0]?.active)
          return res.status(403).json({error:"A unidade deste colaborador está inativa."});
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


  // Clientes cadastrados entram no portal com marca própria e sessão separada
  // dos operadores e do MASTER. A conta não usa cookie nem API da Postal.
  const customerCookie=(value,age)=>"wl_customer_session="+encodeURIComponent(value)+
    "; HttpOnly; SameSite=Lax; Path=/api/wl/customer; Max-Age="+age+
    (process.env.NODE_ENV==="production"?"; Secure":"");
  const maskedCustomer=account=>({id:account.id,clientId:account.client_id,
    name:account.name,email:account.email,
    mustChangePassword:account.must_change_password});
  const customerQuoteRate=new Map();
  async function authenticateCustomer(req,res,next){
    const token=verifySession(parseCookies(req).wl_customer_session);
    if(!token||token.aud!=="white-label-customer"||!safeId(token.carrierId)||!safeId(token.accountId))
      return res.status(401).json({error:"Sessão do cliente expirada. Entre novamente."});
    try{
      const [account,carrier]=await Promise.all([
        wlCustomerDb.byId(pool,token.carrierId,token.accountId),
        wlDb.carrierById(pool,token.carrierId)
      ]);
      if(!account||!account.active||!account.client_active||account.point_id&&account.point_active!==true||
        !carrier||carrier.status!=="DRAFT"||
        Number(account.session_version)!==Number(token.version))
        return res.status(403).json({error:"Conta ou vínculo do cliente desativado."});
      if(["POST","PUT","PATCH","DELETE"].includes(req.method)){
        const v=Buffer.from(text(req.get("x-csrf-token")));
        const expected=Buffer.from(text(token.csrf));
        if(!v.length||v.length!==expected.length||!crypto.timingSafeEqual(v,expected))
          return res.status(403).json({error:"Sessão inválida. Recarregue o portal."});
      }
      req.wlCustomer={carrier,account,token};
      next();
    }catch(error){safeError(res,error,"Não foi possível validar o cliente.");}
  }
  app.get("/wl/:code/cliente",async(req,res)=>{
    if(!validCode(req.params.code))return res.status(404).send("Transportadora não encontrada.");
    try{
      const carrier=await wlDb.carrierByCode(pool,carrierCode(req.params.code));
      if(!carrier||carrier.status!=="DRAFT")return res.status(404).send("Transportadora não encontrada.");
      res.setHeader("Cache-Control","private,no-store");
      res.sendFile(path.join(__dirname,"public","white-label-customer.html"));
    }catch(error){res.status(503).send("Portal do cliente indisponível.");}
  });
  app.post("/api/wl/customer/login",async(req,res)=>{
    const email=text(req.body?.email).toLowerCase();
    const code=carrierCode(req.body?.code);
    const password=String(req.body?.password||"");
    if(!validCode(code)||!/^\S+@\S+\.\S+$/.test(email))
      return res.status(401).json({error:"Credenciais inválidas."});
    const rate=checkLoginRate(req,"wlc:"+code+":"+email);
    if(!rate.ok)return res.status(429).json({error:"Muitas tentativas. Tente novamente."});
    try{
      const carrier=await wlDb.carrierByCode(pool,code);
      const account=carrier?await wlCustomerDb.byEmail(pool,carrier.id,email):null;
      if(!account||!account.active||!account.client_active||
        account.point_id&&account.point_active!==true||
        !carrier||carrier.status!=="DRAFT"||
        !verifyPassword(password,account.password_hash)){
        recordLoginFailure(rate.key);
        return res.status(401).json({error:"Credenciais inválidas."});
      }
      clearLoginFailures(rate.key);
      const csrf=crypto.randomBytes(24).toString("base64url");
      const session=signSession({aud:"white-label-customer",accountId:account.id,
        carrierId:carrier.id,version:Number(account.session_version),csrf,
        exp:Date.now()+6*60*60*1000});
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Set-Cookie",customerCookie(session,21600));
      res.json({ok:true,csrf,account:maskedCustomer(account),brand:logic.publicBrand(carrier)});
    }catch(error){safeError(res,error,"Não foi possível entrar na conta.");}
  });
  app.post("/api/wl/customer/logout",(_req,res)=>{
    res.setHeader("Set-Cookie",customerCookie("",0));
    res.json({ok:true});
  });
  app.get("/api/wl/customer/session",authenticateCustomer,(req,res)=>{
    res.setHeader("Cache-Control","private,no-store");
    res.json({ok:true,csrf:req.wlCustomer.token.csrf,
      account:maskedCustomer(req.wlCustomer.account),
      brand:logic.publicBrand(req.wlCustomer.carrier),
      capabilities:{manual:true,xmlNfe:true,xmlDce:true,fiscalKey:true,
        integratedQuote:true,ownRoutes:true,multiVolume:true,savedAddresses:true,
        issuance:false,payment:false,shippingLabels:false,wallet:false,
        bulkIssue:false,webhooks:false}});
  });
  app.post("/api/wl/customer/password",authenticateCustomer,async(req,res)=>{
    const old=String(req.body?.currentPassword||""),next=String(req.body?.nextPassword||"");
    if(next.length<12||next.length>128||!/[^a-zA-Z0-9]/.test(next)||!/[A-Z]/.test(next)||!/[0-9]/.test(next))
      return res.status(400).json({error:"Senha nova requer 12 caracteres, maiúscula, número e símbolo."});
    if(old===next||!verifyPassword(old,req.wlCustomer.account.password_hash))
      return res.status(400).json({error:"Senha atual incorreta ou senha repetida."});
    try{
      await wlCustomerDb.updatePassword(pool,req.wlCustomer.carrier.id,
        req.wlCustomer.account.id,hashPassword(next));
      res.setHeader("Set-Cookie",customerCookie("",0));
      res.json({ok:true,reloginRequired:true});
    }catch(error){safeError(res,error,"Não foi possível trocar a senha.");}
  });
  app.get("/api/wl/customer/profile",authenticateCustomer,(req,res)=>{
    const a=req.wlCustomer.account;
    res.setHeader("Cache-Control","private,no-store");
    res.json({name:a.name,email:a.email,document:a.document||"",phone:a.phone||"",
      sender:{name:a.name,document:a.document||"",phone:a.phone||"",email:a.email,
        cep:a.cep||"",address:a.street||"",number:a.number||"",
        neighborhood:a.neighborhood||"",city:[a.city,a.state].filter(Boolean).join("/")},
      brand:logic.publicBrand(req.wlCustomer.carrier)});
  });
  app.get("/api/wl/customer/addresses",authenticateCustomer,async(req,res)=>{
    try{
      const a=req.wlCustomer.account;
      const rows=await wlCustomerDb.listAddresses(pool,req.wlCustomer.carrier.id,a.client_id);
      res.setHeader("Cache-Control","private,no-store");
      res.json({addresses:rows});
    }catch(error){safeError(res,error,"Não foi possível listar os endereços.");}
  });
  app.post("/api/wl/customer/addresses",authenticateCustomer,async(req,res)=>{
    if(req.wlCustomer.account.must_change_password)
      return res.status(403).json({error:"Troque sua senha inicial para salvar endereços."});
    try{
      const value=wlCustomer.normalizeSavedAddress(req.body);
      const row=await wlCustomerDb.createAddress(pool,req.wlCustomer.carrier.id,
        req.wlCustomer.account.client_id,value);
      if(!row)return res.status(409).json({error:"Limite de 30 endereços por conta."});
      res.status(201).json({ok:true,address:row});
    }catch(error){safeError(res,error,"Não foi possível salvar o endereço.");}
  });
  app.delete("/api/wl/customer/addresses/:id",authenticateCustomer,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Endereço inválido."});
    if(req.wlCustomer.account.must_change_password)
      return res.status(403).json({error:"Troque sua senha inicial."});
    try{
      const removed=await wlCustomerDb.deleteAddress(pool,req.wlCustomer.carrier.id,
        req.wlCustomer.account.client_id,req.params.id);
      res.json({ok:removed});
    }catch(error){safeError(res,error,"Não foi possível excluir o endereço.");}
  });
  app.post("/api/wl/customer/quote",authenticateCustomer,async(req,res)=>{
    const account=req.wlCustomer.account;
    if(account.must_change_password)return res.status(403).json({error:"Troque a senha inicial antes de cotar."});
    const key=String(account.id),now=Date.now(),prior=customerQuoteRate.get(key);
    const bucket=prior&&now-prior.start<60000?prior:{start:now,count:0};
    bucket.count++;customerQuoteRate.set(key,bucket);
    if(customerQuoteRate.size>2500)customerQuoteRate.clear();
    if(bucket.count>5)return res.status(429).json({error:"Limite de 5 consultas por minuto."});
    try{
      const input=wlCustomer.normalizeVolumes(req.body);
      const point=account.point_id
        ?await wlClientsDb.getPoint(pool,req.wlCustomer.carrier.id,account.point_id):null;
      if(account.point_id&&(!point||!point.active))
        return res.status(403).json({error:"Ponto da conta inativo."});
      const client=await wlClientsDb.getClient(pool,req.wlCustomer.carrier.id,account.client_id);
      const percent=client?.point_commission_override!=null
        ?Number(client.point_commission_override):Number(point?.commission_percent||0);
      const parts=[];
      let networkStatus="AVAILABLE";
      for(const volume of input.volumes){
        const rates=await wlDb.quoteTariffs(pool,req.wlCustomer.carrier.id,volume);
        const own=rates.map(r=>logic.pricedTariff(r,req.wlCustomer.carrier,volume.weight)).filter(Boolean);
        let net={status:"UNAVAILABLE",options:[]};
        try{if(typeof quoteIntegrated==="function")
          net=await quoteIntegrated(volume,req.wlCustomer.carrier);}catch(error){
          console.warn("WL_CUSTOMER_PROVIDER_QUOTE",error.status||error.code||"failure");
        }
        if(net.status!=="AVAILABLE")
          networkStatus=net.status==="UNAVAILABLE"?"UNAVAILABLE":networkStatus==="UNAVAILABLE"?networkStatus:"NONE";
        parts.push({own,integrated:net.status==="AVAILABLE"?net.options:[]});
      }
      const options=wlCustomer.foldQuotes(parts,logic.publicBrand(req.wlCustomer.carrier),false,percent);
      res.setHeader("Cache-Control","private,no-store");
      res.json({simulation:true,shippingEnabled:false,paymentsEnabled:false,
        networkStatus,volumeCount:input.volumes.length,
        options,brand:logic.publicBrand(req.wlCustomer.carrier)});
    }catch(error){safeError(res,error,"Não foi possível cotar volumes.");}
  });

  // Reutiliza o parser/template do Postal Balcão sem criar envios nem debitar saldo.
  app.get("/api/wl/customer/bulk/template",authenticateCustomer,async(req,res)=>{
    try{
      const output=await bulkShipping.template();
      res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",'attachment; filename="modelo-envios-white-label.xlsx"');
      res.setHeader("Cache-Control","private,no-store");
      res.send(Buffer.from(output));
    }catch(error){safeError(res,error,"Não foi possível gerar o modelo da planilha.");}
  });
  app.post("/api/wl/customer/bulk/parse",authenticateCustomer,async(req,res)=>{
    if(req.wlCustomer.account.must_change_password)
      return res.status(403).json({error:"Troque sua senha inicial."});
    try{
      const parsed=await bulkShipping.parseUpload(req.body||{});
      res.setHeader("Cache-Control","private,no-store");
      res.json({rows:parsed.rows,valid:parsed.valid,invalid:parsed.invalid,
        previewOnly:true,issueEnabled:false});
    }catch(error){res.status(400).json({error:error.message||"Planilha inválida."});}
  });
  app.post("/api/wl/customer/fiscal-lookup",authenticateCustomer,async(req,res)=>{
    if(req.wlCustomer.account.must_change_password)return res.status(403).json({error:"Troque sua senha inicial."});
    if(typeof lookupFiscalDocument!=="function")return res.status(503).json({error:"Consulta fiscal não configurada."});
    // Validação de CPF/CNPJ do titular também é aplicada dentro do serviço fiscal compartilhado.
    return lookupFiscalDocument(req,res,req.wlCustomer.account.document||"");
  });

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
        address:p.address,number:p.number,active:p.active,
        ...(req.wl.account.role==="WL_MASTER"?{pointCommissionPercent:Number(p.commission_percent||0)}:{})
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


  app.post("/api/wl/clients/:id/access",
    authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Cliente inválido."});
    try{
      const fixed=await wlClientsDb.getClient(pool,req.wl.carrier.id,req.params.id);
      if(!fixed||!fixed.active)return res.status(404).json({error:"Cliente inativo ou inexistente."});
      if(!fixed.email)return res.status(400).json({error:"Cadastre o e-mail do cliente antes de gerar acesso."});
      const password="Wlc@"+crypto.randomBytes(12).toString("base64url");
      const account=await wlCustomerDb.provision(pool,req.wl.carrier.id,fixed.id,
        fixed.email,hashPassword(password));
      if(!account)return res.status(409).json({error:"Cliente ou ponto vinculado está inativo."});
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,email:account.email,temporaryPassword:password,
        loginUrl:"/wl/"+encodeURIComponent(req.wl.carrier.code)+"/cliente",
        mustChangePassword:true,
        note:"Copie agora. Gerar novo acesso revoga todas as sessões anteriores do cliente."});
    }catch(error){safeError(res,error,"Não foi possível gerar acesso do cliente.");}
  });

  // Cliente fixo sempre pertence a uma transportadora; operadores só acessam seu ponto.
  app.get("/api/wl/clients",authenticate,async(req,res)=>{
    try{
      const scope=req.wl.account.role==="WL_OPERATOR"?req.wl.account.point_id:null;
      const rows=await wlClientsDb.listClients(pool,req.wl.carrier.id,scope);
      res.setHeader("Cache-Control","private,no-store");
      res.json({clients:rows.map(row=>wlClients.publicClient(row,req.wl.account.role==="WL_MASTER"))});
    }catch(error){safeError(res,error,"Não foi possível consultar os clientes.");}
  });
  app.post("/api/wl/clients",authenticate,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    try{
      const master=req.wl.account.role==="WL_MASTER";
      if(!master&&req.body?.pointCommissionOverride!=null&&req.body.pointCommissionOverride!=="")
        return res.status(403).json({error:"Comissões especiais só podem ser definidas pelo MASTER."});
      const data=wlClients.normalizeClient(master?req.body:{...req.body,
        pointId:req.wl.account.point_id,pointCommissionOverride:null,active:true});
      const count=await wlClientsDb.countClients(pool,req.wl.carrier.id);
      if(count>=300)return res.status(409).json({error:"Limite inicial de 300 clientes por transportadora."});
      const created=await wlClientsDb.createClient(pool,req.wl.carrier.id,req.wl.account.id,
        data,master?data.pointId:req.wl.account.point_id,master);
      res.setHeader("Cache-Control","no-store");
      res.status(201).json({ok:true,client:wlClients.publicClient(created,master)});
    }catch(error){safeError(res,error,"Não foi possível cadastrar o cliente fixo.");}
  });
  app.put("/api/wl/clients/:id",authenticate,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Identificador de cliente inválido."});
    try{
      const master=req.wl.account.role==="WL_MASTER";
      if(!master&&req.body?.pointCommissionOverride!=null&&req.body.pointCommissionOverride!=="")
        return res.status(403).json({error:"Comissões especiais só podem ser definidas pelo MASTER."});
      const data=wlClients.normalizeClient(master?req.body:{...req.body,
        pointId:req.wl.account.point_id,pointCommissionOverride:null,active:true});
      const client=await wlClientsDb.updateClient(pool,req.wl.carrier.id,req.params.id,
        master?null:req.wl.account.point_id,data,master?data.pointId:req.wl.account.point_id,master);
      if(!client)return res.status(404).json({error:"Cliente não encontrado nesta unidade."});
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,client:wlClients.publicClient(client,master)});
    }catch(error){safeError(res,error,"Não foi possível atualizar o cliente.");}
  });
  app.patch("/api/wl/clients/:id/status",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id)||typeof req.body?.active!=="boolean")
      return res.status(400).json({error:"Informe identificador e situação válidos."});
    try{
      const row=await wlClientsDb.setClientActive(pool,req.wl.carrier.id,req.params.id,req.body.active);
      if(!row)return res.status(404).json({error:"Cliente não encontrado."});
      res.json({ok:true,id:row.id,active:req.body.active});
    }catch(error){safeError(res,error,"Não foi possível alterar o cliente.");}
  });
  app.patch("/api/wl/points/:id/commission",authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Unidade inválida."});
    try{
      const rate=wlClients.percent(req.body?.pointCommissionPercent,"Comissão padrão do ponto");
      const point=await wlClientsDb.setPointCommission(pool,req.wl.carrier.id,req.params.id,rate);
      if(!point)return res.status(404).json({error:"Ponto ativo não encontrado nesta transportadora."});
      res.json({ok:true,id:point.id,pointCommissionPercent:Number(point.commission_percent)});
    }catch(error){safeError(res,error,"Não foi possível atualizar a comissão do ponto.");}
  });

  // Coletas internas White Label: não envolvem postagem, etiqueta, carteira ou split.
  // Toda consulta e alteração usa carrier_id da sessão; operadores ficam limitados ao próprio ponto.
  app.get("/api/wl/collections",authenticate,async(req,res)=>{
    try{
      const scope=req.wl.account.role==="WL_OPERATOR"?req.wl.account.point_id:null;
      const rows=await wlCollectionDb.listCollections(pool,req.wl.carrier.id,scope,150);
      res.setHeader("Cache-Control","private,no-store");
      res.json({collections:rows.map(wlCollection.publicCollection),financialEnabled:false,
        message:"Ordens operacionais, sem cobrança, emissão ou repasse automático."});
    }catch(error){safeError(res,error,"Não foi possível consultar as coletas.");}
  });
  app.post("/api/wl/collections",authenticate,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    try{
      const data=wlCollection.normalizeCollection(req.body);
      const pointId=req.wl.account.role==="WL_OPERATOR"?req.wl.account.point_id:data.pointId;
      if(req.wl.account.role==="WL_OPERATOR"&&!pointId)
        return res.status(403).json({error:"Operador sem unidade de coleta."});
      const result=await wlCollectionDb.createCollection(
        pool,req.wl.carrier.id,req.wl.account.id,data,pointId);
      res.setHeader("Cache-Control","no-store");
      res.status(result.created?201:200).json({ok:true,created:result.created,
        collection:wlCollection.publicCollection(result.row),financialEnabled:false});
    }catch(error){safeError(res,error,"Não foi possível registrar a coleta.");}
  });
  app.patch("/api/wl/collections/:id/assign",
    authenticate,wlMaster,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id)||!safeId(req.body?.pointId))
      return res.status(400).json({error:"Informe coleta e unidade válidas."});
    const driverName=text(req.body?.driverName);
    if(driverName.length>100)
      return res.status(400).json({error:"Nome do responsável deve ter até 100 caracteres."});
    try{
      const row=await wlCollectionDb.assignCollection(
        pool,req.wl.carrier.id,req.params.id,req.body.pointId,driverName);
      if(!row)return res.status(409).json({error:"Coleta não encontrada, já em rota ou unidade indisponível."});
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,collection:wlCollection.publicCollection(row)});
    }catch(error){safeError(res,error,"Não foi possível atribuir a coleta.");}
  });
  app.patch("/api/wl/collections/:id/status",
    authenticate,blockNewUsersUntilPasswordChanged,async(req,res)=>{
    if(!safeId(req.params.id))return res.status(400).json({error:"Identificador de coleta inválido."});
    try{
      const status=String(req.body?.status||"").toUpperCase();
      const previous=wlCollection.allowedPrior(status,req.wl.account.role);
      const scope=req.wl.account.role==="WL_OPERATOR"?req.wl.account.point_id:null;
      const row=await wlCollectionDb.transitionCollection(
        pool,req.wl.carrier.id,req.params.id,scope,status,previous);
      if(!row)return res.status(409).json({error:"Coleta indisponível ou alteração de situação não permitida."});
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,collection:wlCollection.publicCollection(row)});
    }catch(error){safeError(res,error,"Não foi possível atualizar a coleta.");}
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
    const accountId=String(req.wl.account.id);
    const now=Date.now();
    const previous=hybridQuoteRate.get(accountId);
    const entry=!previous || now-previous.start>=60000 ? {start:now,count:0} : previous;
    entry.count++;
    hybridQuoteRate.set(accountId,entry);
    if(hybridQuoteRate.size>2500)hybridQuoteRate.clear();
    if(entry.count>12){
      res.setHeader("Retry-After",String(Math.max(1,Math.ceil((60000-(now-entry.start))/1000))));
      return res.status(429).json({error:"Muitas cotações. Aguarde um minuto antes de consultar novamente."});
    }
    try{
      // Dimensões reais são obrigatórias para a consulta à rede.
      const args=hybrid.validateHybridQuote(req.query);
      const master=req.wl.account.role==="WL_MASTER";
      const clientId=String(req.query.clientId||"").trim();
      if(clientId&&!safeId(clientId))return res.status(400).json({error:"Cliente fixo inválido."});
      const client=clientId?await wlClientsDb.getClient(pool,req.wl.carrier.id,clientId,
        master?null:req.wl.account.point_id):null;
      if(clientId&&(!client||!client.active))return res.status(404).json({error:"Cliente inativo ou não encontrado nesta unidade."});
      const chosenPointId=String(req.query.pointId||"").trim();
      if(master&&chosenPointId&&!safeId(chosenPointId))
        return res.status(400).json({error:"Ponto inválido."});
      if(master&&client&&chosenPointId&&chosenPointId!==client.point_id)
        return res.status(400).json({error:"O ponto escolhido não corresponde ao cliente fixo."});
      const pointId=master?(client?client.point_id:(chosenPointId||null)):req.wl.account.point_id;
      const point=pointId?await wlClientsDb.getPoint(pool,req.wl.carrier.id,pointId):null;
      if(pointId&&(!point||!point.active))return res.status(404).json({error:"Ponto de origem não encontrado ou inativo."});
      const commission=client?.point_commission_override!=null
        ?Number(client.point_commission_override):Number(point?.commission_percent||0);
      const rows=await wlDb.quoteTariffs(pool,req.wl.carrier.id,args);
      const own=rows.map(rate=>logic.pricedTariff(rate,req.wl.carrier,args.weight)).filter(Boolean);
      let integrated={status:"UNAVAILABLE",options:[]};
      try{
        if(typeof quoteIntegrated==="function"){
          integrated=await quoteIntegrated(args,req.wl.carrier);
        }
      }catch(error){
        console.warn("WL_INTEGRATED_QUOTE_UNAVAILABLE",error.status||error.code||error.name||"unknown");
      }
      const networkOptions=integrated?.status==="AVAILABLE" && Array.isArray(integrated.options)
        ? integrated.options : [];
      const brand=logic.publicBrand(req.wl.carrier);
      // Primeiro calcula a comissão contratual da Postal e da rede.
      // Depois divide exclusivamente a fatia White Label entre ponto e MASTER.
      const combined=hybrid.mergeHybridOptions(own,networkOptions,brand,true);
      const options=combined.map(option=>wlClients.allocateCommission(option,pointId?commission:0,master));
      res.setHeader("Cache-Control","private,no-store");
      res.json({
        brand,simulation:true,shippingEnabled:false,paymentsEnabled:false,
        integrated:{status:["AVAILABLE","NONE"].includes(integrated?.status)?integrated.status:"UNAVAILABLE",
          count:networkOptions.length},
        count:{own:own.length,integrated:networkOptions.length},
        client:client?{id:client.id,name:client.name}:null,
        ...(master?{commercial:{pointName:point?.name||"",pointCommissionPercent:pointId?commission:0,
          basis:"PARCELA_WHITE_LABEL",financialProjection:true}}:{}),
        options
      });
    }catch(error){safeError(res,error,"Não foi possível simular esta cotação.");}
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
