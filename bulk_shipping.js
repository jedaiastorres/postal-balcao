"use strict";
const crypto = require("crypto");
const ExcelJS = require("exceljs");

const HEADERS = Object.freeze([
  "pedido_referencia","remetente_nome","remetente_cpf_cnpj","remetente_telefone","remetente_email",
  "remetente_cep","remetente_logradouro","remetente_numero","remetente_bairro",
  "remetente_complemento","remetente_cidade_uf",
  "destinatario_nome","destinatario_cpf_cnpj","destinatario_telefone","destinatario_email",
  "destinatario_cep","destinatario_logradouro","destinatario_numero","destinatario_bairro",
  "destinatario_complemento","destinatario_cidade_uf",
  "peso_por_volume_kg","comprimento_cm","largura_cm","altura_cm","quantidade_volumes",
  "valor_declarado_total","descricao_conteudo","quantidade_itens","valor_unitario",
  "documento_tipo","documento_chave"
]);
const MAX_ROWS = 100;
const MAX_BYTES = 900000;
const digits = x => String(x == null ? "" : x).replace(/\D/g,"");
const txt = (x,max=180) => String(x == null ? "" : x).trim().slice(0,max);
const monetary = x => {
  const v=String(x == null?"":x).trim();
  if (/^\d{1,3}(?:\.\d{3})*,\d+$/.test(v)) return Number(v.replace(/\./g,"").replace(",","."));
  return Number(v.replace(",","."));
};
function cellText(cell) {
  if (!cell) return "";
  if (cell.formula || cell.sharedFormula) throw new Error("O modelo não aceita fórmulas. Cole somente os valores.");
  const v = cell.value;
  if(v==null) return "";
  if(typeof v==="object") {
    if(Array.isArray(v.richText)) return v.richText.map(z=>z.text||"").join("");
    if(v.text!=null) return String(v.text);
    if(v.result!=null) return String(v.result);
    throw new Error("Formato de célula inválido. Use apenas texto ou números.");
  }
  return String(v);
}
function splitCsv(content) {
  const str=String(content||"").replace(/^\uFEFF/,"");
  const first=str.split(/\r?\n/,1)[0];
  const delimiter=(first.match(/;/g)||[]).length >= (first.match(/,/g)||[]).length ? ";" : ",";
  const rows=[];let row=[],value="",quoted=false;
  for(let i=0;i<str.length;i++){
    const c=str[i], next=str[i+1];
    if(c==='"'){
      if(quoted && next==='"'){value+='"';i++;}
      else quoted=!quoted;
    }else if(c===delimiter && !quoted){row.push(value);value="";}
    else if((c==="\n"||c==="\r")&&!quoted){
      if(c==="\r"&&next==="\n")i++;
      row.push(value);value="";
      if(row.some(x=>x.trim()!==""))rows.push(row);
      row=[];
    }else{value+=c;}
  }
  if(quoted)throw Error("Aspas não fechadas no arquivo CSV.");
  row.push(value);
  if(row.some(x=>x.trim()!==""))rows.push(row);
  return rows;
}
function parseParty(prefix, entry) {
  const read = suffix => txt(entry[prefix+"_"+suffix]);
  const rawCep = digits(read("cep"));
  const cep = rawCep.padStart(8,"0");
  const cityUf=read("cidade_uf");
  return {
    name:read("nome"),document:digits(read("cpf_cnpj")),phone:digits(read("telefone")),
    email:read("email"),cep,address:read("logradouro"),number:read("numero"),
    neighborhood:read("bairro"),complement:read("complemento"),city:cityUf
  };
}
function validateRecord(entry, line) {
  const errors=[];
  const ref=txt(entry.pedido_referencia,80);
  const sender=parseParty("remetente",entry), recipient=parseParty("destinatario",entry);
  const checkParty=(party,label)=>{
    if(!party.name)errors.push(label+": nome obrigatório");
    if(![11,14].includes(party.document.length))errors.push(label+": CPF/CNPJ com 11 ou 14 dígitos");
    if(party.phone.length<10 || party.phone.length>11)errors.push(label+": telefone com DDD obrigatório");
    if(!/^\d{8}$/.test(party.cep))errors.push(label+": CEP com 8 dígitos");
    if(!party.address || !party.number || !party.neighborhood || !/^[^/]{2,}\/[A-Za-z]{2}$/.test(party.city)){
      errors.push(label+": complete logradouro, número, bairro e Cidade/UF");
    }
  };
  if(!ref) errors.push("pedido_referencia obrigatório");
  checkParty(sender,"Remetente");checkParty(recipient,"Destinatário");
  const weight=monetary(entry.peso_por_volume_kg),length=monetary(entry.comprimento_cm),
    width=monetary(entry.largura_cm),height=monetary(entry.altura_cm);
  const count=Number(entry.quantidade_volumes),amount=monetary(entry.valor_declarado_total);
  const itemQuantity=Number(entry.quantidade_itens),itemUnitValue=monetary(entry.valor_unitario);
  for(const [name,value] of [["Peso por volume",weight],["Comprimento",length],["Largura",width],["Altura",height]]){
    if(!Number.isFinite(value)||value<=0)errors.push(name+" deve ser maior que zero");
  }
  if(weight>300)errors.push("Peso por volume muito elevado");
  if(!Number.isInteger(count)||count<1||count>50)errors.push("Quantidade de volumes: de 1 a 50");
  if(!Number.isFinite(amount)||amount<0)errors.push("Valor declarado inválido");
  if(!Number.isInteger(itemQuantity)||itemQuantity<1)errors.push("Quantidade de itens inválida");
  if(!Number.isFinite(itemUnitValue)||itemUnitValue<0)errors.push("Valor unitário inválido");
  const description=txt(entry.descricao_conteudo,200);
  if(!description)errors.push("Descrição do conteúdo obrigatória");
  const documentType=txt(entry.documento_tipo,20).toUpperCase()||"DECLARACAO";
  const key=digits(entry.documento_chave);
  if(!["NFE","DCE","DECLARACAO"].includes(documentType))errors.push("Tipo de documento: NFE, DCE ou DECLARACAO");
  if(documentType!=="DECLARACAO" && (key.length!==44 || key.slice(20,22)!==(documentType==="NFE"?"55":"99"))){
    errors.push("Chave de NF-e/DC-e deve ter 44 dígitos e modelo correspondente");
  }
  if(documentType==="DECLARACAO" && key)errors.push("Declaração manual não deve conter chave fiscal");
  return {
    line,ref,sender,recipient,weight,length,width,height,count,
    declaredValue:amount,items:[{description,quantity:itemQuantity,value:itemUnitValue}],
    documentType,documentKey:key,
    errors
  };
}
function validateTable(table) {
  if(!Array.isArray(table)||!table.length)throw Error("A planilha não possui cabeçalho.");
  const headers=table[0].map(x=>txt(x,100).toLowerCase());
  const missed=HEADERS.filter(k=>!headers.includes(k));
  if(missed.length)throw Error("Colunas obrigatórias ausentes: "+missed.slice(0,8).join(", "));
  if(table.length-1>MAX_ROWS)throw Error("O limite é de 100 envios por planilha.");
  const seen=new Set(),result=[];
  for(let idx=1;idx<table.length;idx++){
    const cells=table[idx];
    if(cells.every(x=>txt(x)===""))continue;
    const obj={};for(let h=0;h<headers.length;h++)if(HEADERS.includes(headers[h]))obj[headers[h]]=cells[h]||"";
    const row=validateRecord(obj,idx+1);
    if(seen.has(row.ref) && row.ref)row.errors.push("Referência repetida na planilha");
    seen.add(row.ref);
    result.push(row);
  }
  if(!result.length)throw Error("Preencha ao menos um envio na aba Envios.");
  return result;
}
async function parseUpload({name,contentBase64}) {
  const raw=String(contentBase64||"");
  if(!raw || raw.length>1300000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(raw))throw Error("Arquivo inválido ou muito grande (máximo 900 KB).");
  const buf=Buffer.from(raw,"base64");
  if(buf.length>MAX_BYTES||buf.length===0)throw Error("Arquivo inválido ou muito grande (máximo 900 KB).");
  const filename=String(name||"").toLowerCase();
  let table;
  if(filename.endsWith(".xlsx")){
    const wb=new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws=wb.getWorksheet("Envios");
    if(!ws)throw Error("A planilha precisa ter uma aba chamada Envios.");
    if(ws.rowCount>MAX_ROWS+1)throw Error("O limite é de 100 envios.");
    const width=Math.min(ws.columnCount,100);
    table=[];
    for(let r=1;r<=ws.rowCount;r++){
      const cells=[];
      for(let c=1;c<=width;c++)cells.push(cellText(ws.getRow(r).getCell(c)));
      table.push(cells);
    }
  } else if(filename.endsWith(".csv")){
    table=splitCsv(buf.toString("utf8"));
  } else throw Error("Use o modelo .xlsx ou arquivo CSV com as mesmas colunas.");
  const rows=validateTable(table);
  const fingerprint=crypto.createHash("sha256").update(buf).digest("hex").slice(0,40);
  return {fingerprint,rows,valid:rows.filter(x=>!x.errors.length).length,invalid:rows.filter(x=>x.errors.length).length};
}
async function template() {
  const wb=new ExcelJS.Workbook();wb.creator="Postal Serviços";wb.title="Modelo de Postagens em Massa - Postal Balcão";
  const ws=wb.addWorksheet("Envios",{views:[{state:"frozen",ySplit:1}]});
  ws.columns=HEADERS.map(key=>({header:key,key,width:key.includes("logradouro")||key.includes("descricao")?30:key.includes("nome")?25:key.includes("cidade")?20:19}));
  ws.getRow(1).height=32;ws.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};
  ws.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFBD003D"}};
  ws.getRow(1).alignment={vertical:"middle",wrapText:true};
  ws.autoFilter={from:"A1",to:{row:1,column:HEADERS.length}};
  for(let row=2;row<=101;row++){
    const r=ws.getRow(row);r.height=22;
    for(let col=1;col<=HEADERS.length;col++){
      const cell=r.getCell(col);
      cell.numFmt="@";
      if(row%2===0)cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF7F8FB"}};
    }
  }
  const docColumn=HEADERS.indexOf("documento_tipo")+1;
  ws.getColumn(docColumn).eachCell({includeEmpty:true},(cell,r)=>{if(r>1)cell.dataValidation={type:"list",allowBlank:true,formulae:['"NFE,DCE,DECLARACAO"']}});
  const notes=wb.addWorksheet("Instrucoes");
  notes.columns=[{width:26},{width:106}];
  const tips=[
    ["POSTAL BALCÃO","PLANILHA MODELO PARA POSTAGENS EM MASSA"],
    ["Como usar","Preencha a aba Envios: uma linha por pedido, com referência única. Não altere os cabeçalhos."],
    ["Dados fiscais","Informe NFE (modelo 55) ou DCE (modelo 99) com chave de 44 dígitos. Use DECLARACAO e deixe a chave vazia quando não houver documento."],
    ["Medidas","peso_por_volume_kg, comprimento_cm, largura_cm e altura_cm correspondem a CADA VOLUME físico embalado."],
    ["Vários volumes","quantidade_volumes: de 1 a 50. O sistema cria o número indicado de volumes com as medidas da linha."],
    ["Valor declarado","valor_declarado_total é o valor total da mercadoria do pedido (R$), rateado entre os volumes para a cotação."],
    ["Cidade e UF","Digite como Parauapebas/PA, São Paulo/SP etc."],
    ["CEPs","Use sempre o CEP REAL do remetente e do destinatário. Quando houver CEP máscara habilitado, o Postal Balcão aplica automaticamente o hub na cotação."],
    ["Pagamento","Importar NÃO debita saldo. Primeiro calcule os fretes, confira as opções e confirme a contratação. O saldo é debitado por pedido confirmado."],
    ["Coleta","Após emitir os envios, selecione as etiquetas e solicite coleta em lote na Central de Pedidos."],
    ["Limites","Até 100 pedidos por arquivo e até 900 KB. Evite fórmulas e não apague a aba Envios."],
    ["Observação","Os valores das cotações só serão mostrados após consulta ao provedor. Nenhum preço de exemplo é uma oferta."],
  ];
  notes.getRange?.("A1");
  for(let i=0;i<tips.length;i++){
    const row=notes.addRow(tips[i]);row.height=i===0?34:41;
    row.getCell(1).font={bold:true,color:{argb:i===0?"FFFFFFFF":"FF1F2937"}};
    row.getCell(2).alignment={wrapText:true,vertical:"middle"};
    if(i===0)for(const c of row._cells)c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFBD003D"}};
    else if(i%2===0)for(const c of row._cells)c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF7F8FB"}};
  }
  return wb.xlsx.writeBuffer();
}
module.exports={HEADERS,template,parseUpload,validateTable,validateRecord,splitCsv};
