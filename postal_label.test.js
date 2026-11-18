"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {PDFDocument}=require("pdf-lib");
const label=require("./postal_label");

test("etiqueta própria em A6 contém imagem QR incorporada por volume",async()=>{
  const bytes=await label.generate({
    id:"89aa11b2-3a9e-45f8-8c12-599a11441111",package_count:2,
    sender:{name:"Cliente Postal",city:"Parauapebas",cep:"68515000"},
    recipient:{name:"Destinatário",address:"Rua principal",number:"10",city:"Xinguara",cep:"68555000"},
    package_data:{ownRoute:{originCity:"Parauapebas",destinationCity:"Xinguara"}}
  },{index:1,trackingCode:"PS89AA11B23A9E45F88C1201"});
  assert.equal(Buffer.isBuffer(bytes),true);
  const doc=await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(),1);
  assert.deepEqual(doc.getPage(0).getSize(),{width:283.46,height:425.2});
  const raw=Buffer.from(bytes).toString("latin1");
  assert.ok(raw.includes("/Subtype /Image"),"PDF precisa conter QR em imagem");
});
