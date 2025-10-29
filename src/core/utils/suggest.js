export function buildSuggestedPayload(contract, { mode = 'min' } = {}) {
  const reqSet = new Set((contract.fields || []).filter(f => f.required).map(f => f.key));
  const keys = mode === 'min'
    ? [...reqSet]
    : (contract.fields || []).map(f => f.key);

  const out = JSON.parse(JSON.stringify(contract.payloadShape || {}));

  const assign = (obj, pathArr, value) => {
    let ref = obj;
    for (let i=0;i<pathArr.length-1;i++) {
      const p = pathArr[i];
      if (p.endsWith('[]')) {
        const name = p.slice(0, -2);
        ref[name] = ref[name] || [{}];
        ref = ref[name][0];
      } else {
        ref[p] = ref[p] || {};
        ref = ref[p];
      }
    }
    ref[pathArr[pathArr.length-1]] = value;
  };

  for (const k of keys) {
    const parts = k.split('.');
    const t = (contract.fields || []).find(f => f.key === k)?.type || 'text';
    const placeholder =
      t === 'email' ? 'usuario@dominio.com' :
      t === 'rfc' ? 'XAXX010101000' :
      t === 'money' ? 1000 :
      t === 'number' ? 1 :
      t === 'enum' ? (contract.defaults?.[k] || 'VALOR') :
      (contract.defaults?.[k] || 'VALOR_EJEMPLO');
    assign(out, parts, placeholder);
  }
  return out;
}
