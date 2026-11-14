/* Leitor local de XML NF-e/DC-e. O arquivo nunca sai do navegador. */
(function (global) {
  "use strict";
  const digits = value => String(value || "").replace(/\D/g, "");
  const children = element => element ? Array.from(element.children || []) : [];
  const child = (element, name) => children(element).find(node => node.localName === name) || null;
  const first = (element, name) => element && typeof element.getElementsByTagNameNS === "function"
    ? element.getElementsByTagNameNS("*", name)[0] || null : null;
  const field = (element, name) => (child(element, name)?.textContent || "").trim();
  const directOrNested = (parent, names) => {
    let node = parent;
    for (const name of names) node = child(node, name);
    return node;
  };
  const asNumber = val => Number(String(val || "0").replace(",", "."));
  const roundMoney = val => Math.round((Number(val) + Number.EPSILON) * 100) / 100;
  function readParty(element, addressTag) {
    const address = child(element, addressTag) || child(element, "enderReme")
      || child(element, "enderRem") || child(element, "enderEmit")
      || child(element, "enderDest") || element;
    return {
      name: field(element, "xNome"),
      document: field(element, "CNPJ") || field(element, "CPF"),
      phone: field(element, "fone") || field(address, "fone"),
      email: field(element, "email"),
      cep: digits(field(address, "CEP")),
      address: field(address, "xLgr"),
      number: field(address, "nro"),
      neighborhood: field(address, "xBairro"),
      complement: field(address, "xCpl"),
      city: [field(address, "xMun"), field(address, "UF")].filter(Boolean).join("/")
    };
  }
  function extractKey(info) {
    const id = String(info?.getAttribute("Id") || "").trim();
    const match = id.match(/(?:NFe|DCe)(\d{44})$/i);
    return match ? match[1] : "";
  }
  function readProducts(info) {
    return children(info).filter(n => n.localName === "det").map(det => {
      const prod = child(det, "prod");
      const qty = asNumber(field(prod, "qCom")) || 1;
      const total = asNumber(field(prod, "vProd"));
      const unit = asNumber(field(prod, "vUnCom")) || (qty > 0 ? total / qty : total);
      return {
        description: field(prod, "xProd"),
        quantity: qty,
        value: roundMoney(unit)
      };
    }).filter(item => item.description).slice(0, 200);
  }
  function parse(xml, expectedType = "") {
    if (typeof xml !== "string" || xml.length < 40 || xml.length > 3000000) throw Error("XML vazio ou maior que 3 MB.");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("XML com entidades externas não é aceito.");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw Error("O arquivo XML não está bem formado.");
    const nfe = first(doc, "infNFe");
    const dce = first(doc, "infDCe");
    if (!nfe && !dce) throw Error("XML não reconhecido. Envie um XML de NF-e ou DC-e.");
    const type = nfe ? "NFE" : "DCE";
    if (expectedType && expectedType !== type) throw Error("Tipo selecionado diferente do arquivo importado.");
    const info = nfe || dce;
    const key = extractKey(info);
    if (!key) throw Error("A chave de acesso de 44 dígitos não foi encontrada no XML.");

    const senderNode = type === "NFE" ? child(info, "emit") : child(info, "rem");
    const receiverNode = child(info, "dest");
    if (!senderNode || !receiverNode) throw Error("O XML não contém remetente e destinatário completos.");

    const totalElement = type === "NFE"
      ? directOrNested(info, ["total", "ICMSTot"])
      : child(info, "total");
    const declaredValue = asNumber(type === "NFE"
      ? field(totalElement, "vNF")
      : (field(totalElement, "vDC") || field(info, "vDC")));
    const volume = type === "NFE" ? first(info, "vol") : null;
    const volumeCount = Number(field(volume, "qVol")) || null;
    const grossWeightKg = asNumber(field(volume, "pesoB")) || null;

    return {
      type, key,
      sender: readParty(senderNode, type === "NFE" ? "enderEmit" : "enderReme"),
      recipient: readParty(receiverNode, "enderDest"),
      items: readProducts(info),
      declaredValue: Number.isFinite(declaredValue) && declaredValue >= 0 ? roundMoney(declaredValue) : 0,
      volumeCount: volumeCount && volumeCount > 0 && volumeCount <= 50 ? volumeCount : null,
      grossWeightKg: grossWeightKg && grossWeightKg > 0 ? grossWeightKg : null,
      source: "XML_LOCAL"
    };
  }
  global.PostalFiscalDocument = Object.freeze({ parse });
})(window);
