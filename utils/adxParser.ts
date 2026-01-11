import { ADXFile, ADXParameter, ADXBit, GaugeConfig } from '../types';

export const parseADX = (xmlString: string, fileName: string): ADXFile => {
  const startIndex = xmlString.indexOf('<');
  if (startIndex === -1) throw new Error("Filen innehåller ingen giltig XML-data.");
  const cleanXml = xmlString.substring(startIndex).trim();

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(cleanXml, "text/xml");
  
  // Baudrate
  let baudRate = 8192; 
  const baudNode = xmlDoc.getElementsByTagName("baud")[0];
  if (baudNode && baudNode.textContent) {
    const parsedBaud = parseInt(baudNode.textContent);
    if (!isNaN(parsedBaud)) baudRate = parsedBaud;
  }

  // Leta efter inställningar för eko-reducering (finns ofta i listen/monitor sektioner)
  let echoCancel = true; // Standard för ALDL
  const echoNode = xmlDoc.getElementsByTagName("echocancel")[0] || xmlDoc.getElementsByTagName("echo")[0];
  if (echoNode) echoCancel = echoNode.textContent?.toLowerCase() === "true" || echoNode.textContent === "1";

  const parameters: ADXParameter[] = [];
  const bits: ADXBit[] = [];

  const paramNodes = xmlDoc.getElementsByTagName("ADXVALUE");
  for (let i = 0; i < paramNodes.length; i++) {
    const node = paramNodes[i];
    const id = node.getAttribute("id");
    const title = node.getAttribute("title");
    const offsetNode = node.getElementsByTagName("packetoffset")[0];
    
    if (id && title && offsetNode) {
      let scale = 1.0;
      let offset = 0.0;
      
      const factorNode = node.getElementsByTagName("factor")[0] || node.getElementsByTagName("scale")[0];
      const offsetValNode = node.getElementsByTagName("offset")[0];
      
      if (factorNode) scale = parseFloat(factorNode.textContent || "1.0");
      if (offsetValNode) offset = parseFloat(offsetValNode.textContent || "0.0");

      parameters.push({
        id,
        title,
        units: node.getElementsByTagName("units")[0]?.textContent || "",
        packetOffset: parseInt(offsetNode.textContent || "0"),
        byteCount: parseInt(node.getElementsByTagName("bytecount")[0]?.textContent || "1"),
        scale,
        offset
      });

      const bitNodes = node.getElementsByTagName("ADXBIT");
      for (let j = 0; j < bitNodes.length; j++) {
        const bitNode = bitNodes[j];
        const bitId = bitNode.getAttribute("id") || `bit-${id}-${j}`;
        const bitTitle = bitNode.getAttribute("title");
        const bitPosNode = bitNode.getElementsByTagName("bitposition")[0];
        if (bitTitle && bitPosNode) {
          bits.push({
            id: bitId,
            title: bitTitle,
            packetOffset: parseInt(offsetNode.textContent || "0"),
            bitOffset: parseInt(bitPosNode.textContent || "0")
          });
        }
      }
    }
  }

  let requestCommand: number[] | undefined;
  const commandNodes = xmlDoc.getElementsByTagName("ADXCOMMAND");
  
  for (let i = 0; i < commandNodes.length; i++) {
    const cmd = commandNodes[i];
    const title = (cmd.getAttribute("title") || "").toUpperCase();
    const sendNode = cmd.getElementsByTagName("sendcommanddata")[0];
    
    if (sendNode) {
      const hexStr = sendNode.textContent || "";
      const bytes = hexStr.split(/[\s,]+/)
        .filter(x => x.trim())
        .map(h => parseInt(h.startsWith('0x') ? h : '0x' + h, 16));

      // Vi letar efter huvudkommandot för att hämta data
      if (!requestCommand && (title.includes("DATA") || title.includes("REQUEST") || title.includes("MODE 1"))) {
        requestCommand = bytes;
      }
    }
  }

  // Beräkna förväntad paketlängd
  let maxOffset = 0;
  parameters.forEach(p => {
    const end = p.packetOffset + p.byteCount;
    if (end > maxOffset) maxOffset = end;
  });
  // Checksumman ligger oftast efter sista databytet
  const expectedPacketLength = maxOffset + 1;

  const initialGauges: GaugeConfig[] = parameters
    .filter(p => ["RPM", "TPS", "MAP", "TEMP", "SPEED", "VOLT", "O2"].some(s => p.title.toUpperCase().includes(s)))
    .slice(0, 6)
    .map(p => ({
      id: `g-${p.id}`,
      label: p.title,
      unit: p.units,
      min: 0,
      max: p.title.toUpperCase().includes("RPM") ? 7000 : 
           p.title.toUpperCase().includes("TPS") ? 100 : 255,
      color: '#3b82f6',
      field: p.id
    }));

  return {
    id: Math.random().toString(36).substr(2, 9),
    name: xmlDoc.documentElement.getAttribute("title") || fileName,
    mask: xmlDoc.documentElement.getAttribute("mask") || "Unknown",
    description: "ALDL Definition",
    gauges: initialGauges,
    parameters,
    bits,
    initialData: {},
    requestCommand: requestCommand || [0xF4, 0x57, 0x01, 0x00, 0xB4],
    expectedPacketLength,
    baudRate,
    echoCancel
  };
};