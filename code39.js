"use strict";

// Code 39: os 9 elementos de cada caractere alternam barra/espaço;
// bits 1 representam elementos largos. Compatível com leitores 1D comuns.
// Tabela de padrões: especificação implementada pelo projeto ZXing (Apache 2.0).
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
const PATTERNS = [
  0x034, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064,
  0x109, 0x049, 0x148, 0x019, 0x118, 0x058, 0x00d, 0x10c, 0x04c, 0x01c,
  0x103, 0x043, 0x142, 0x013, 0x112, 0x052, 0x007, 0x106, 0x046, 0x016,
  0x181, 0x0c1, 0x1c0, 0x091, 0x190, 0x0d0, 0x085, 0x184, 0x0c4, 0x0a8,
  0x0a2, 0x08a, 0x02a
];
const START_STOP = 0x094;

function modules(value) {
  if (typeof value !== "string" || !/^[A-Z0-9]{6,40}$/.test(value)) {
    throw new Error("Código de rastreio inválido para código de barras.");
  }
  const result = [];
  const symbols = [START_STOP, ...Array.from(value, letter => PATTERNS[ALPHABET.indexOf(letter)]), START_STOP];
  symbols.forEach((pattern, symbolIndex) => {
    for (let element = 0; element < 9; element++) {
      const wide = Boolean(pattern & (1 << (8 - element)));
      result.push(...Array(wide ? 2 : 1).fill(element % 2 === 0));
    }
    if (symbolIndex !== symbols.length - 1) result.push(false);
  });
  return result;
}

function draw(page, value, {x, y, width, height}) {
  const bars = modules(value);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error("Área de impressão do código de barras inválida.");
  }
  const unit = width / bars.length;
  let start = -1;
  for (let i = 0; i <= bars.length; i++) {
    if (i < bars.length && bars[i] && start < 0) start = i;
    if ((i === bars.length || !bars[i]) && start >= 0) {
      page.drawRectangle({x:x + start * unit, y, width:(i-start)*unit, height});
      start = -1;
    }
  }
  return {moduleCount:bars.length, moduleWidth:unit};
}

module.exports = {modules, draw};
