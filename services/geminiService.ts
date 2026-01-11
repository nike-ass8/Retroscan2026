import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { ECMData } from "../types";

export const analyzeEngineState = async (data: ECMData): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const sensorData = Object.entries(data)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, val]) => `${key}: ${typeof val === 'number' ? val.toFixed(2) : val}`)
    .join('\n');

  const prompt = `Analysera följande motorvärden från en äldre GM/Opel ALDL ECM i realtid:
  ${sensorData}
  Baserat på dessa värden, ge en snabb teknisk diagnos på svenska (max 3-4 meningar).`;

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
    });
    return response.text || "Kunde inte generera analys.";
  } catch (err) {
    return "AI-analys tillfälligt ej tillgänglig.";
  }
};

export const getDTCExplanation = async (code: string): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Förklara felkoden ${code} för en äldre GM/Opel med ALDL (OBD-I) på svenska.`,
    });
    return response.text || "Ingen information hittades.";
  } catch (err) {
    return "Kunde inte hämta förklaring.";
  }
};