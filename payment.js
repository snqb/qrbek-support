const MAX_JSON_BYTES = 20_000;
const MAX_QR_BYTES = 20_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Public bank catalog. Prefixes are the only ELQR URL wrappers accepted here. */
export const BANKS = Object.freeze([
  { id: "mbank", name: "MBANK", prefix: "https://app.mbank.kg/qr/#", icon: "/assets/banks/mbank.png", allowAsSource: true },
  { id: "bakai", name: "Bakai Bank", prefix: "https://bakai.app/#", icon: "/assets/banks/bakai.png", allowAsSource: true },
  { id: "optima", name: "Optima Bank", prefix: "https://mobile.optima24.kg/my-qr/confirm-screen?qr-url=#", icon: "/assets/banks/optima.png", allowAsSource: true },
  { id: "demir", name: "DemirBank", prefix: "https://retail.demirbank.kg/#", icon: "/assets/banks/demir.png", allowAsSource: true },
  { id: "odengi", name: "О! Деньги", prefix: "https://api.dengi.o.kg/#", icon: "/assets/banks/odengi.png", allowAsSource: true },
  { id: "megapay", name: "MegaPay", prefix: "https://megapay.kg/get#", icon: "/assets/banks/megapay.png", allowAsSource: true },
  { id: "eldik", name: "Eldik Bank", prefix: "https://app.eldik.kg/#", icon: "/assets/banks/eldik.png", allowAsSource: true },
  { id: "simbank", name: "Simbank", prefix: "https://simbank.kg/scan_to_pay?payload=#", icon: "/assets/banks/simbank.png", allowAsSource: true },
  { id: "kompanion", name: "Компаньон", prefix: "https://24.kompanion.kg/qr/#", icon: "/assets/banks/kompanion.png", allowAsSource: true },
  { id: "kicb", name: "KICB", prefix: "https://bank.kicb.net/#", icon: "/assets/banks/kicb.png", allowAsSource: true },
  { id: "nambaone", name: "NambaOne", prefix: "https://nambaone.app/#", icon: "/assets/banks/nambaone.png", allowAsSource: true },
  { id: "balance", name: "Balance", prefix: "https://balance.kg/#", icon: "/assets/banks/balance.png", allowAsSource: true },
  { id: "ab24", name: "АБ24", prefix: "https://qr.ab.kg/#", icon: "/assets/banks/ab24.png", allowAsSource: true },
  { id: "dantepay", name: "DantePay", prefix: "https://dantepay.kg/elqr/form?qrLink=#", icon: "/assets/banks/dantepay.png", allowAsSource: true },
  { id: "finik", name: "Finik", prefix: "https://qr.finik.kg/#", icon: "/assets/banks/finik.png", allowAsSource: true },
  { id: "bankasia", name: "Bank of Asia", prefix: "https://www.bankasia.kg/#", icon: "/assets/banks/bankasia.png", allowAsSource: false },
]);

const bankById = new Map(BANKS.map((bank) => [bank.id, bank]));
const merchantAliases = new Map([
  ["mbank", ["mbank"]],
  ["bakai", ["bakai"]],
  ["optima", ["optima"]],
  ["demir", ["demirbank", "demir.kg", "demir"]],
  ["odengi", ["odengi", "dengi", "o.dengi", ".o.kg", "obank", "nurtelecom"]],
  ["megapay", ["megapay", "mega.kg"]],
  ["eldik", ["eldik", "rsk"]],
  ["simbank", ["simbank", "doscredo", "dcb"]],
  ["kompanion", ["kompanion", "companion"]],
  ["kicb", ["kicb"]],
  ["nambaone", ["nambaone", "namba"]],
  ["balance", ["balance", "beeline"]],
  ["ab24", ["ab24", "ab.kg", "aiyl", "ayyl"]],
  ["dantepay", ["dantepay", "dante", "payline"]],
  ["finik", ["finik"]],
  ["bankasia", ["bankasia", "bank asia", "bankasia.kg", "qr.p2p.bankasia.kg"]],
]);

function error(message) {
  throw new Error(`Ошибка: ${message}`);
}

function utf8Size(value) {
  return textEncoder.encode(value).byteLength;
}

function codePointCount(value) {
  return Array.from(value).length;
}

function normalizeAmount(value, field = "сумма") {
  if (typeof value !== "string") error(`${field} должна быть строкой`);
  if (value === "") return "";
  if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(value)) {
    error(`${field}: используйте десятичное число с точкой и не более 2 знаков после неё`);
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (cents < 1n || cents > 99_999_999_999n) error(`${field} должна быть от 0.01 до 999999999.99 KGS`);
  return value;
}
function amountCents(value) {
  const normalized = normalizeAmount(value, "сумма");
  if (normalized === "") return null;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) error(`${label} должна быть объектом`);
}

export function normalizePage(input) {
  assertPlainObject(input, "Страница оплаты");
  const expected = ["v", "title", "note", "amount", "currency", "methods"];
  const unknown = Object.keys(input).filter((key) => !expected.includes(key));
  if (unknown.length) error(`неизвестное поле: ${unknown[0]}`);
  if (input.v !== 1) error("поддерживается только версия страницы v=1");
  for (const field of ["title", "note", "currency"]) {
    if (typeof input[field] !== "string") error(`${field} должна быть строкой`);
  }
  if (codePointCount(input.title) > 80) error("заголовок слишком длинный (максимум 80 символов)");
  if (codePointCount(input.note) > 240) error("примечание слишком длинное (максимум 240 символов)");
  if (input.currency !== "KGS") error("поддерживается только валюта KGS");
  const amount = normalizeAmount(input.amount);
  if (!Array.isArray(input.methods) || input.methods.length < 1 || input.methods.length > 8) {
    error("нужно указать от 1 до 8 способов оплаты");
  }
  const seenMethods = new Set();
  const methods = input.methods.map((method, index) => {
    assertPlainObject(method, `способ оплаты ${index + 1}`);
    const methodFields = ["kind", "label", "value", "bankId"];
    const extra = Object.keys(method).filter((key) => !methodFields.includes(key));
    if (extra.length) error(`способ оплаты ${index + 1}: неизвестное поле ${extra[0]}`);
    if (typeof method.kind !== "string" || !/^(qr|account|phone)$/.test(method.kind)) error(`способ оплаты ${index + 1}: неизвестный вид`);
    if (typeof method.label !== "string" || codePointCount(method.label) > 80) error(`способ оплаты ${index + 1}: название до 80 символов`);
    if (typeof method.value !== "string" || method.value.trim() === "" || utf8Size(method.value) > 3000) error(`способ оплаты ${index + 1}: непустое значение до 3000 байт`);
    if (typeof method.bankId !== "string" || (method.bankId !== "" && !bankById.has(method.bankId))) {
      error(`способ оплаты ${index + 1}: неизвестный банк`);
    }
    const identity = `${method.kind}\u0000${method.value}\u0000${method.bankId}`;
    if (seenMethods.has(identity)) error(`способ оплаты ${index + 1}: дубликат`);
    seenMethods.add(identity);
    return { kind: method.kind, label: method.label, value: method.value, bankId: method.bankId };
  });
  return { v: 1, title: input.title, note: input.note, amount, currency: "KGS", methods };
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    error("некорректная base64url-ссылка");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (bytesToBase64Url(bytes) !== value) error("некорректная base64url-ссылка");
    return bytes;
  } catch (caught) {
    if (caught instanceof Error && caught.message.startsWith("Ошибка:")) throw caught;
    error("некорректная base64url-ссылка");
  }
}

export function encodePage(input) {
  const page = normalizePage(input);
  const json = JSON.stringify(page);
  const bytes = textEncoder.encode(json);
  if (bytes.byteLength > MAX_JSON_BYTES) error("страница слишком большая");
  return bytesToBase64Url(bytes);
}

export function decodePage(encoded) {
  if (typeof encoded !== "string") error("ссылка страницы должна быть строкой");
  let value = encoded;
  if (value.startsWith("#p=")) value = value.slice(3);
  else if (value.startsWith("p=")) value = value.slice(2);
  if (value.length > Math.ceil(MAX_JSON_BYTES / 3) * 4) error("страница слишком большая");
  if (value.includes("#") || value.includes("?") || value.includes("/")) error("некорректный фрагмент страницы");
  const bytes = base64UrlToBytes(value);
  if (bytes.byteLength > MAX_JSON_BYTES) error("страница слишком большая");
  let json;
  try {
    json = textDecoder.decode(bytes);
  } catch {
    error("страница содержит некорректный UTF-8 текст");
  }
  try {
    return normalizePage(JSON.parse(json));
  } catch (caught) {
    if (caught instanceof Error && caught.message.startsWith("Ошибка:")) throw caught;
    error("страница содержит некорректный JSON");
  }
}

function decodeFragmentOnce(value) {
  if (!value.includes("%")) return value;
  const bytes = [];
  let text = "";
  const flush = () => {
    if (text) {
      bytes.push(...textEncoder.encode(text));
      text = "";
    }
  };
  for (let i = 0; i < value.length;) {
    if (value[i] !== "%") {
      text += value[i++];
      continue;
    }
    const encoded = [];
    while (i < value.length && value[i] === "%") {
      if (i + 2 >= value.length || !/^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) error("QR содержит некорректное URL-кодирование");
      encoded.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 3;
    }
    flush();
    bytes.push(...encoded);
  }
  flush();
  try {
    return textDecoder.decode(Uint8Array.from(bytes));
  } catch {
    error("QR содержит некорректный UTF-8 фрагмент");
  }
}

function valueEndForLength(data, start, length) {
  const end = start + length;
  return end <= data.length ? end : -1;
}

function parseTlv(data) {
  const fields = [];
  const byTag = new Map();
  let index = 0;
  while (index < data.length) {
    if (data.length - index < 4 || !/^[0-9]{4}$/.test(data.slice(index, index + 4))) return null;
    const tag = data.slice(index, index + 2);
    const length = Number(data.slice(index + 2, index + 4));
    if (byTag.has(tag)) return null;
    const valueStart = index + 4;
    const end = valueEndForLength(data, valueStart, length);
    if (end < 0) return null;
    const value = data.slice(valueStart, end);
    fields.push({ tag, value, start: index, end });
    byTag.set(tag, value);
    index = end;
  }
  return { fields, byTag };
}

function merchantBank(merchantId) {
  const text = String(merchantId || "").toLowerCase();
  let selected = null;
  let selectedLength = 0;
  for (const [id, aliases] of merchantAliases) {
    for (const alias of aliases) {
      if (alias && text.includes(alias.toLowerCase()) && alias.length > selectedLength) {
        selected = bankById.get(id);
        selectedLength = alias.length;
      }
    }
  }
  return selected;
}

function wrapperFor(value) {
  const hash = value.indexOf("#");
  if (hash < 0 || value.indexOf("#", hash + 1) >= 0) return null;
  const prefix = value.slice(0, hash + 1);
  return BANKS.find((bank) => bank.prefix === prefix) || null;
}

function sbpUrl(value) {
  if (!value.startsWith("https://qr.nspk.ru/")) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return parsed.protocol === "https:" && parsed.hostname === "qr.nspk.ru" && parsed.port === "" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" && /^\/A[SD][A-Za-z0-9_-]{6,200}$/.test(parsed.pathname);
}

function crc16(value) {
  let crc = 0xffff;
  for (const byte of textEncoder.encode(value)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) error("в этой среде недоступен crypto.subtle");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function checksumInfo(payload, parsed) {
  const crcField = parsed.fields.find((field) => field.tag === "63");
  if (!crcField) return { valid: true, scheme: null, crc: null };
  if (parsed.fields[parsed.fields.length - 1] !== crcField || crcField.value.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(crcField.value)) {
    return { valid: false, scheme: null, crc: crcField.value };
  }
  const beforeCrc = payload.slice(0, crcField.start);
  const supplied = crcField.value.toUpperCase();
  const emv = crc16(`${beforeCrc}6304`);
  if (emv === supplied) return { valid: true, scheme: "emv", crc: supplied };
  const deployed = (await sha256Hex(beforeCrc)).slice(-4);
  if (deployed === supplied) return { valid: true, scheme: "sha256", crc: supplied };
  return { valid: false, scheme: null, crc: supplied };
}

function merchantData(parsed) {
  const top = parsed.byTag;
  const merchantField = parsed.fields.find(({ tag }) => tag !== "34" && Number(tag) >= 26 && Number(tag) <= 51);
  let nested = null;
  if (merchantField) {
    nested = parseTlv(merchantField.value);
    if (!nested) return null;
  }
  const merchantId = nested?.byTag.get("00") || "";
  const account = nested?.byTag.get("10") || nested?.byTag.get("01") || "";
  const names = [top.get("59") || "", top.get("34") || "", nested?.byTag.get("59") || "", nested?.byTag.get("34") || ""].filter((value) => value.trim());
  const score = (value) => {
    const normalized = value.toLowerCase();
    const letters = Array.from(value).filter((char) => /\p{L}/u.test(char)).length;
    const words = value.trim().split(/\s+/).length;
    return letters + (words >= 2 ? 10 : 2) - (/[0-9]/.test(value) ? 14 : 0) - (/(bank|банк|mbank|o!bank|demir|bakai|optima|megapay|eldik|simbank|kompanion|dantepay)/i.test(normalized) ? 20 : 0);
  };
  const name = names.length ? names.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best) : "";
  return { merchantId, account, name };
}

function parseElqrSource(value) {
  const trimmed = value.trim();
  let payload = trimmed;
  let wrapper = null;
  if (!trimmed.startsWith("0002")) {
    wrapper = wrapperFor(trimmed);
    if (!wrapper) error("разрешён только известный URL банка Кыргызстана или raw ELQR");
    const hash = trimmed.indexOf("#");
    payload = decodeFragmentOnce(trimmed.slice(hash + 1));
  }
  if (!payload.startsWith("0002") || utf8Size(payload) > MAX_QR_BYTES) error("некорректный ELQR payload");
  const parsed = parseTlv(payload);
  if (!parsed || parsed.fields.length === 0) error("ELQR содержит неполный или повреждённый TLV");
  const currency = parsed.byTag.get("53");
  if (currency && currency !== "417") error("QR не в валюте KGS");
  const country = parsed.byTag.get("58");
  if (parsed.byTag.has("54")) {
    if (parsed.byTag.get("54") === "") error("сумма в QR пуста");
    normalizeAmount(parsed.byTag.get("54"), "сумма в QR");
  }
  if (country && country.toUpperCase() !== "KG") error("QR не относится к Кыргызстану");
  const details = merchantData(parsed);
  if (!details) error("ELQR содержит повреждённые данные получателя");
  const merchant = merchantBank(details.merchantId);
  const routeBank = merchant || wrapper;
  if (!routeBank) error("банк получателя не распознан");
  return { trimmed, payload, parsed, wrapper, routeBank, details };
}

export async function inspectQr(value) {
  if (typeof value !== "string" || value.trim() === "") error("QR должен быть непустой строкой");
  const trimmed = value.trim();
  if (sbpUrl(trimmed)) return { payload: trimmed, bankId: "", name: "СБП", account: "", amount: null, mutableAmount: false, kind: "sbp" };
  const source = parseElqrSource(trimmed);
  const checks = await checksumInfo(source.payload, source.parsed);
  if (!checks.valid) error("контрольная сумма QR не прошла проверку");
  const initiation = source.parsed.byTag.get("01");
  const signed = source.parsed.byTag.has("64");
  const fixed = source.parsed.byTag.has("54");
  const mutableAmount = !signed && !fixed && (!initiation || initiation === "11");
  return {
    payload: source.payload,
    bankId: source.routeBank.id,
    name: source.details.name,
    account: source.details.account,
    amount: source.parsed.byTag.get("54") ?? null,
    mutableAmount,
    kind: "elqr",
  };
}

function encodeFragmentPayload(payload) {
  return encodeURIComponent(payload);
}

function wrapPayload(payload, bank) {
  return bank.prefix + encodeFragmentPayload(payload);
}


export async function paymentTarget(value, amount = "", sourceBankId = "") {
  if (typeof value !== "string" || value.trim() === "") error("QR должен быть непустой строкой");
  const requested = normalizeAmount(amount, "запрошенная сумма");
  const trimmed = value.trim();
  if (sbpUrl(trimmed)) {
    return { qrText: trimmed, url: trimmed, amount: requested, amountApplied: false, notice: requested ? "СБП не поддерживает изменение суммы; сумма указана только информационно" : "" };
  }
  const source = parseElqrSource(trimmed);
  const checks = await checksumInfo(source.payload, source.parsed);
  if (!checks.valid) error("контрольная сумма QR не прошла проверку");
  let selectedBank = source.routeBank;
  if (sourceBankId !== "") {
    selectedBank = bankById.get(sourceBankId);
    if (!selectedBank) error("неизвестный банк оплаты");
    if (!selectedBank.allowAsSource) error("этот банк нельзя выбрать как банк оплаты");
  }
  const targetUrl = (payload) => wrapPayload(payload, selectedBank);
  const qrTextFor = (payload, url, preserveOriginal = false) => preserveOriginal
    ? (trimmed.startsWith("0002") ? payload : (sourceBankId ? url : trimmed))
    : (trimmed.startsWith("0002") ? payload : url);
  const existing = source.parsed.byTag.get("54");
  if (!requested) {
    const url = trimmed.startsWith("0002") || sourceBankId ? targetUrl(source.payload) : trimmed;
    return { qrText: qrTextFor(source.payload, url, true), url, amount: existing ?? "", amountApplied: false, notice: "" };
  }
  if (existing && amountCents(existing) === amountCents(requested)) {
    const url = trimmed.startsWith("0002") || sourceBankId ? targetUrl(source.payload) : trimmed;
    return { qrText: qrTextFor(source.payload, url, true), url, amount: existing, amountApplied: false, notice: "" };
  }
  const initiation = source.parsed.byTag.get("01");
  if (existing || source.parsed.byTag.has("64") || (initiation && initiation !== "11")) {
    error("этот QR нельзя изменить: сумма фиксирована или QR динамический/подписанный");
  }
  const rewritten = await replaceAmountAsync(source.payload, source, requested, checks.scheme);
  const url = targetUrl(rewritten);
  return { qrText: qrTextFor(rewritten, url), url, amount: requested, amountApplied: true, notice: "" };
}

async function replaceAmountAsync(payload, source, amount, scheme) {
  const checksumField = source.parsed.fields.find((field) => field.tag === "63");
  const bodyEnd = checksumField ? checksumField.start : payload.length;
  const insertionField = source.parsed.fields.find((field) => field.tag !== "63" && Number(field.tag) > 54);
  const insertion = insertionField ? insertionField.start : bodyEnd;
  const amountFieldText = `54${String(amount.length).padStart(2, "0")}${amount}`;
  const withAmount = payload.slice(0, insertion) + amountFieldText + payload.slice(insertion, bodyEnd);
  if (scheme === "sha256") return `${withAmount}6304${(await sha256Hex(withAmount)).slice(-4)}`;
  return `${withAmount}6304${crc16(`${withAmount}6304`)}`;
}
