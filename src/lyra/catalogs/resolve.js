const MOCK = {
  cat_regimen_fiscal: [
    { code: '605', label: 'Régimen de Sueldos y Salarios e Ingresos Asimilados a Salarios', alt: ['sueldos', 'salarios'] },
    { code: '621', label: 'Régimen de Personas Físicas con Actividades Empresariales', alt: ['personas fisicas', 'pf', 'actividades empresariales'] },
  ],
  cat_uso_cfdi: [
    { code: 'G03', label: 'Gastos en general', alt: ['gastos generales', 'gastos'] },
  ],
  cat_forma_pago: [
    { code: '01', label: 'Efectivo', alt: ['cash', 'efectivo'] },
    { code: '03', label: 'Transferencia electrónica de fondos', alt: ['transferencia', 'spei'] },
  ],
  cat_metodo_pago: [
    { code: 'PUE', label: 'Pago en una sola exhibición', alt: ['pago único', 'contado', 'pue'] },
    { code: 'PPD', label: 'Pago en parcialidades o diferido', alt: ['parcialidades', 'diferido', 'ppd'] },
  ],
  catn_moneda: [
    { code: 'MXN', label: 'Peso Mexicano', alt: ['peso', 'mxn', 'pesos'] },
    { code: 'USD', label: 'Dólar Americano', alt: ['usd', 'dolar', 'dólar'] },
  ],
};

export async function resolveCatalog(optionsRef, userText) {
  const list = MOCK[optionsRef] || [];
  const q = String(userText || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  let best = null; let score = 0;
  for (const it of list) {
    const hay = [it.label, ...(it.alt || [])].join(' | ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const s = similarity(q, hay);
    if (s > score) { score = s; best = it; }
  }
  return score >= 0.55 ? best : null;
}

function similarity(a, b) {
  // jaccard tosco de tokens
  const A = new Set(a.split(/\W+/).filter(Boolean));
  const B = new Set(b.split(/\W+/).filter(Boolean));
  const inter = new Set([...A].filter(x => B.has(x))).size;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}
