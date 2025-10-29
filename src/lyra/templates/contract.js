// src/lyra/templates/contract.js

// Tool: templates.contract
// Usa el http del contextFactory (con token del request) y NO importa la URL directo.
export default function templatesContract(contextFactory) {
  // Devolvemos la función que ejecuta el tool
  return async function run(input = {}) {
    const { http } = contextFactory(); // http ya viene con baseURL + token
    const { templateId } = input;

    if (!templateId) {
      const err = new Error('templateId requerido');
      err.status = 400;
      throw err;
    }

    // Llama al endpoint de contract del API de Lyra
    const { data } = await http.get(`/templates/${templateId}/contract`);
    // Puedes normalizar si quieres, por ahora devolvemos tal cual
    return data;
  };
}
