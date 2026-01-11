import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Settings, 
  ShieldAlert, 
  Monitor, 
  Zap, 
  Plus, 
  Play, 
  CircleStop, 
  Edit3, 
  X, 
  ChevronLeft, 
  ChevronRight,
  Database,
  Trash2,
  Share2,
  AlertCircle,
  FileText,
  UploadCloud,
  CheckCircle2,
  Search,
  Palette
} from 'lucide-react';
import { AppTab, ECMData, ADXFile, GaugeTheme, GaugeConfig } from './types';
import { parseADX } from './utils/adxParser';
import { analyzeEngineState, getDTCExplanation } from './services/geminiService';

const THEMES: Record<GaugeTheme, any> = {
  neon: { bg: 'bg-black/40', card: 'bg-zinc-900/60 border-cyan-500/20', accent: '#06b6d4', text: 'text-cyan-400', shadow: 'shadow-[0_0_15px_rgba(6,182,212,0.1)]' },
  carbon: { bg: 'bg-zinc-950/60', card: 'bg-black/80 border-red-600/30', accent: '#ef4444', text: 'text-red-500', shadow: 'shadow-[0_0_15px_rgba(239,68,68,0.1)]' },
  retro: { bg: 'bg-[#000800]/80', card: 'bg-black border-green-500/30', accent: '#22c55e', text: 'text-green-500', shadow: 'shadow-[0_0_15px_rgba(34,197,94,0.1)]' }
};

const ALDLGauge = ({ config, value, theme }: { config: GaugeConfig, value: number, theme: any }) => {
  const percent = Math.min(100, Math.max(0, ((value - config.min) / (config.max - config.min)) * 100));
  const isWarning = percent > 85;

  return (
    <div className={`relative flex flex-col items-center justify-center p-3 rounded-2xl border ${theme.card} aspect-square overflow-hidden backdrop-blur-md ${theme.shadow}`}>
      <div className="absolute top-2 left-3">
        <span className="text-[8px] font-black uppercase tracking-widest opacity-40">{config.label}</span>
      </div>
      
      <div className="relative w-full h-full flex items-center justify-center mt-2">
        <svg className="w-full h-full -rotate-90 scale-90">
          <circle cx="50%" cy="50%" r="40%" stroke="rgba(255,255,255,0.02)" strokeWidth="4" fill="none" />
          <circle 
            cx="50%" cy="50%" r="40%" 
            stroke={isWarning ? '#ef4444' : theme.accent} 
            strokeWidth="6" 
            fill="none" 
            strokeDasharray="251" 
            strokeDashoffset={251 - (2.51 * percent)}
            style={{ transition: 'stroke-dashoffset 0.15s linear' }}
          />
        </svg>
        
        <div className="absolute flex flex-col items-center">
          <span className={`text-2xl font-black font-lcd tracking-tighter tabular-nums ${isWarning ? 'text-red-500' : theme.text}`}>
            {typeof value === 'number' ? value.toFixed(value < 10 ? 1 : 0) : '0'}
          </span>
          <span className="text-[7px] font-bold opacity-30 uppercase">{config.unit}</span>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(AppTab.DASHBOARD);
  const [currentAdxId, setCurrentAdxId] = useState<string | null>(() => localStorage.getItem('aldl_v4_adx'));
  const [adxLibrary, setAdxLibrary] = useState<ADXFile[]>(() => {
    const saved = localStorage.getItem('aldl_v4_lib');
    return saved ? JSON.parse(saved) : [];
  });
  const [themeName, setThemeName] = useState<GaugeTheme>(() => (localStorage.getItem('aldl_v4_theme') as GaugeTheme) || 'neon');
  const [dashboardPage, setDashboardPage] = useState(0);
  
  const [isConnected, setIsConnected] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [telemetry, setTelemetry] = useState<ECMData>({});
  const [rxCount, setRxCount] = useState(0);
  
  const [editingGaugeIdx, setEditingGaugeIdx] = useState<number | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [dtcInput, setDtcInput] = useState("");
  const [dtcResult, setDtcResult] = useState<string | null>(null);

  const serialPort = useRef<any>(null);
  const pollingRef = useRef(false);
  
  const currentAdx = adxLibrary.find(a => a.id === currentAdxId) || null;
  const theme = THEMES[themeName];

  useEffect(() => {
    localStorage.setItem('aldl_v4_lib', JSON.stringify(adxLibrary));
    if (currentAdxId) localStorage.setItem('aldl_v4_adx', currentAdxId);
    localStorage.setItem('aldl_v4_theme', themeName);
  }, [adxLibrary, currentAdxId, themeName]);

  const handleConnect = async () => {
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: currentAdx?.baudRate || 8192 });
      serialPort.current = port;
      setIsConnected(true);
    } catch (e) {
      alert("Anslutning misslyckades. Välj en seriell port (USB-adapter).");
    }
  };

  const validateChecksum = (data: Uint8Array): boolean => {
    if (data.length < 2) return false;
    let sum = 0;
    for (let i = 0; i < data.length - 1; i++) sum += data[i];
    const checksum = (256 - (sum % 256)) % 256;
    return checksum === data[data.length - 1];
  };

  const startStreaming = async () => {
    if (!serialPort.current || !currentAdx) return;
    setIsPolling(true);
    pollingRef.current = true;
    
    const request = new Uint8Array(currentAdx.requestCommand || [0xF4, 0x57, 0x01, 0x00, 0xB4]);
    const expectedLen = currentAdx.expectedPacketLength || 64;
    const shouldEchoCancel = currentAdx.echoCancel ?? true;

    while (pollingRef.current) {
      try {
        const writer = serialPort.current.writable.getWriter();
        await writer.write(request);
        writer.releaseLock();

        const reader = serialPort.current.readable.getReader();
        let buffer = new Uint8Array(0);
        let timeout = Date.now() + 400; // ALDL är långsamt, 400ms är lagom

        while (buffer.length < (request.length + expectedLen) && Date.now() < timeout) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const newBuf = new Uint8Array(buffer.length + value.length);
            newBuf.set(buffer);
            newBuf.set(value, buffer.length);
            buffer = newBuf;
          }
        }
        reader.releaseLock();

        let responseData = buffer;
        
        // 1. Eko-reducering baserat på ADX-inställning
        if (shouldEchoCancel && buffer.length >= request.length) {
            let matches = true;
            for(let i=0; i<request.length; i++) if(buffer[i] !== request[i]) matches = false;
            if(matches) responseData = buffer.slice(request.length);
        }

        // 2. Synka Paket mot Header från ADX (oftast första byten i requesten)
        const headerByte = request[0];
        let syncIdx = -1;
        for (let i = 0; i < responseData.length; i++) {
          if (responseData[i] === headerByte) {
            syncIdx = i;
            break;
          }
        }

        if (syncIdx !== -1) {
          const packet = responseData.slice(syncIdx, syncIdx + expectedLen);
          if (packet.length === expectedLen && validateChecksum(packet)) {
            const newData: ECMData = { _timestamp: Date.now() };
            currentAdx.parameters.forEach(p => {
              if (p.packetOffset < packet.length) {
                let rawVal = 0;
                if (p.byteCount === 2) {
                  rawVal = (packet[p.packetOffset] << 8) | packet[p.packetOffset + 1];
                } else {
                  rawVal = packet[p.packetOffset];
                }
                newData[p.id] = (rawVal * (p.scale || 1)) + (p.offset || 0);
              }
            });
            setTelemetry(newData);
            setRxCount(c => c + 1);
          }
        }
      } catch (err) {
        console.error("ALDL Error:", err);
      }
      await new Promise(r => setTimeout(r, 20)); // Ge processorn lite andrum
    }
    setIsPolling(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newProfiles: ADXFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const text = await files[i].text();
      try {
        const adx = parseADX(text, files[i].name);
        newProfiles.push(adx);
      } catch (err) { alert("Kunde inte läsa ADX-fil: " + files[i].name); }
    }
    setAdxLibrary(prev => [...prev, ...newProfiles]);
    if (newProfiles.length === 1 && !currentAdxId) setCurrentAdxId(newProfiles[0].id);
  };

  const dashboardGauges = currentAdx?.gauges || [];
  const gaugesPerPage = 6;
  const totalPages = Math.ceil(dashboardGauges.length / gaugesPerPage);
  const currentPageGauges = dashboardGauges.slice(dashboardPage * gaugesPerPage, (dashboardPage + 1) * gaugesPerPage);

  return (
    <div className={`flex flex-col h-screen ${theme.bg} text-white transition-all duration-700`}>
      <header className="h-14 border-b border-white/10 flex items-center justify-between px-5 bg-black/40 backdrop-blur-xl z-50">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full shadow-lg transition-all duration-300 ${isPolling ? 'animate-pulse scale-125' : isConnected ? 'bg-yellow-500' : 'bg-zinc-800'}`} style={{ backgroundColor: isPolling ? theme.accent : undefined }} />
          <div className="flex flex-col">
            <h1 className="text-[9px] font-black uppercase tracking-widest text-white/90 truncate max-w-[120px]">
              {currentAdx?.name || 'LADDA UPP ADX'}
            </h1>
            <span className="text-[7px] font-mono opacity-30">PKTS: {rxCount}</span>
          </div>
        </div>
        <button 
          onClick={isConnected ? (isPolling ? () => pollingRef.current=false : startStreaming) : handleConnect}
          className={`px-4 py-1.5 rounded-lg text-[9px] font-black uppercase border transition-all active:scale-95 ${isPolling ? 'bg-red-500/20 border-red-500/50 text-red-500' : 'bg-white text-black border-white'}`}
          style={!isPolling && isConnected ? { backgroundColor: theme.accent, borderColor: theme.accent, boxShadow: `0 0 10px ${theme.accent}33` } : {}}
        >
          {isPolling ? 'STOPP' : isConnected ? 'STARTA' : 'ANSLUT'}
        </button>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar pb-24">
        {activeTab === AppTab.DASHBOARD && (
          <div className="p-4 flex flex-col min-h-full">
            <div className="grid grid-cols-2 gap-3 mb-6">
              {currentPageGauges.map((g, idx) => (
                <div key={idx} className="relative group">
                  <ALDLGauge config={g} value={Number(telemetry[g.field] || 0)} theme={theme} />
                  <button onClick={() => setEditingGaugeIdx(dashboardPage * gaugesPerPage + idx)} className="absolute top-2 right-2 p-2 bg-black/60 rounded-full opacity-0 group-hover:opacity-100 transition-all border border-white/10"><Edit3 size={10} /></button>
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-6 mb-6">
                <button onClick={() => setDashboardPage(p => Math.max(0, p-1))} className="p-2 opacity-40 active:opacity-100"><ChevronLeft size={18} /></button>
                <span className="text-[9px] font-black opacity-30 tracking-widest">{dashboardPage + 1} / {totalPages}</span>
                <button onClick={() => setDashboardPage(p => Math.min(totalPages-1, p+1))} className="p-2 opacity-40 active:opacity-100"><ChevronRight size={18} /></button>
              </div>
            )}
            <div className="mt-auto">
              {aiAnalysis ? (
                <div className="p-5 bg-indigo-500/10 border border-indigo-500/30 rounded-2xl relative animate-in fade-in duration-500">
                  <button onClick={() => setAiAnalysis(null)} className="absolute top-3 right-3 opacity-30"><X size={14} /></button>
                  <p className="text-[10px] font-mono text-indigo-200/80 leading-relaxed italic pr-4">{aiAnalysis}</p>
                </div>
              ) : (
                <button disabled={!isPolling} onClick={async () => { setIsAnalyzing(true); setAiAnalysis(await analyzeEngineState(telemetry)); setIsAnalyzing(false); }} className="w-full py-4 bg-indigo-600/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center gap-3 text-indigo-400 text-[10px] font-black uppercase tracking-widest disabled:opacity-10 active:bg-indigo-600/20 transition-all">
                  <Zap size={14} className={isAnalyzing ? 'animate-spin' : ''} />
                  {isAnalyzing ? 'ANALYSERAR...' : 'KÖR AI DIAGNOS'}
                </button>
              )}
            </div>
          </div>
        )}

        {activeTab === AppTab.DATA_LIST && (
          <div className="p-4 space-y-1">
            {currentAdx?.parameters.map(p => (
              <div key={p.id} className="flex justify-between items-center p-3 bg-white/5 border border-white/5 rounded-xl">
                <span className="text-[9px] font-black uppercase tracking-tight text-zinc-500">{p.title}</span>
                <div className="flex items-baseline gap-2">
                  <span className={`text-lg font-black font-lcd tabular-nums ${theme.text}`}>{telemetry[p.id] !== undefined ? Number(telemetry[p.id]).toFixed(1) : '---'}</span>
                  <span className="text-[7px] opacity-20 font-bold uppercase">{p.units}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === AppTab.DTC_LIST && (
          <div className="p-6 space-y-6">
            <div className="bg-zinc-900/40 p-6 rounded-3xl border border-white/10 backdrop-blur-md">
              <h3 className="text-[10px] font-black uppercase tracking-widest opacity-30 mb-4 text-center">AI FELKODSUPPSLAG</h3>
              <div className="flex gap-2">
                <input type="text" value={dtcInput} onChange={(e) => setDtcInput(e.target.value)} placeholder="Ex: Kod 32" className="flex-1 bg-black/60 border border-white/10 rounded-xl px-4 py-3 text-sm font-lcd outline-none focus:border-cyan-500/40" />
                <button onClick={async () => { setDtcResult(await getDTCExplanation(dtcInput)); }} className="p-4 text-black rounded-xl active:scale-90 transition-all" style={{ backgroundColor: theme.accent }}><Search size={20} /></button>
              </div>
              {dtcResult && <div className="mt-6 p-5 bg-black/40 rounded-xl border border-white/5"><p className="text-[10px] font-mono text-zinc-400 leading-relaxed">{dtcResult}</p></div>}
            </div>
          </div>
        )}

        {activeTab === AppTab.THEME_SELECT && (
          <div className="p-6 space-y-6">
             <h3 className="text-[10px] font-black uppercase tracking-[0.3em] opacity-40 ml-2">VÄLJ STIL</h3>
             <div className="grid gap-4">
                {(['neon', 'carbon', 'retro'] as GaugeTheme[]).map(t => (
                  <button key={t} onClick={() => setThemeName(t)} className={`p-8 rounded-3xl border-2 text-left flex items-center justify-between transition-all ${themeName === t ? 'bg-white/5 scale-[1.02]' : 'bg-black/20 border-white/5 opacity-40'}`} style={{ borderColor: themeName === t ? THEMES[t].accent : undefined }}>
                    <div className="flex flex-col">
                      <span className="text-xl font-black uppercase tracking-widest" style={{ color: THEMES[t].accent }}>{t}</span>
                      <span className="text-[8px] font-bold opacity-30 mt-1 uppercase tracking-[0.2em]">{t === 'neon' ? 'Modern Cyan Glöd' : t === 'carbon' ? 'Racing Röd Kolfiber' : 'Klassisk Terminal Grön'}</span>
                    </div>
                    {themeName === t && <CheckCircle2 size={32} style={{ color: THEMES[t].accent }} />}
                  </button>
                ))}
             </div>
          </div>
        )}

        {activeTab === AppTab.CONNECTION && (
          <div className="p-6 space-y-8">
            <div className="space-y-4">
              <div className="flex justify-between items-end px-2">
                 <h3 className="text-[10px] font-black uppercase tracking-[0.3em] opacity-40">ADX BIBLIOTEK</h3>
                 <span className="text-[8px] opacity-20 font-bold">{adxLibrary.length} PROFILER</span>
              </div>
              <div className="grid gap-3">
                {adxLibrary.map(adx => (
                  <div key={adx.id} className="relative group overflow-hidden rounded-2xl">
                    <button onClick={() => setCurrentAdxId(adx.id)} className={`w-full p-5 rounded-2xl border text-left transition-all relative z-10 ${currentAdxId === adx.id ? 'bg-white/5 border-white/20 shadow-lg' : 'bg-white/5 border-white/5 opacity-50'}`} style={{ borderColor: currentAdxId === adx.id ? theme.accent : undefined }}>
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <p className="text-xs font-black uppercase tracking-tight">{adx.name}</p>
                          <div className="flex gap-2 items-center"><span className="text-[7px] bg-white/10 px-1.5 py-0.5 rounded font-mono uppercase opacity-60">{adx.baudRate} baud</span><span className="text-[7px] opacity-30 font-bold uppercase">{adx.parameters.length} sensorer</span></div>
                        </div>
                        {currentAdxId === adx.id && <CheckCircle2 size={16} style={{ color: theme.accent }} />}
                      </div>
                    </button>
                    <button onClick={() => setAdxLibrary(l => l.filter(a => a.id !== adx.id))} className="absolute right-0 top-0 bottom-0 px-5 bg-red-500/20 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center"><Trash2 size={18} /></button>
                  </div>
                ))}
              </div>
              <label className="block w-full py-10 border-2 border-dashed border-white/10 rounded-3xl text-center cursor-pointer hover:bg-white/5 transition-all bg-black/20">
                <UploadCloud size={32} className="mx-auto text-zinc-600 mb-2" />
                <span className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40">LADDA UPP ADX-FILER</span>
                <input type="file" className="hidden" accept=".adx" multiple onChange={handleFileUpload}/>
              </label>
            </div>
          </div>
        )}
      </main>

      <nav className="h-20 border-t border-white/10 flex justify-around items-center px-4 bg-black/90 backdrop-blur-2xl fixed bottom-0 left-0 w-full z-[100] pb-6">
        <NavBtn active={activeTab === AppTab.DASHBOARD} onClick={() => setActiveTab(AppTab.DASHBOARD)} icon={<Monitor />} label="DASH" theme={theme} />
        <NavBtn active={activeTab === AppTab.DATA_LIST} onClick={() => setActiveTab(AppTab.DATA_LIST)} icon={<Database />} label="LISTA" theme={theme} />
        <NavBtn active={activeTab === AppTab.DTC_LIST} onClick={() => setActiveTab(AppTab.DTC_LIST)} icon={<ShieldAlert />} label="FEL" theme={theme} />
        <NavBtn active={activeTab === AppTab.THEME_SELECT} onClick={() => setActiveTab(AppTab.THEME_SELECT)} icon={<Palette />} label="STIL" theme={theme} />
        <NavBtn active={activeTab === AppTab.CONNECTION} onClick={() => setActiveTab(AppTab.CONNECTION)} icon={<Settings />} label="ECM" theme={theme} />
      </nav>

      {editingGaugeIdx !== null && (
        <div className="fixed inset-0 z-[200] bg-black/98 p-8 flex flex-col animate-in slide-in-from-bottom duration-300">
          <div className="flex justify-between items-center mb-10"><h2 className="text-sm font-black uppercase tracking-widest opacity-40">VÄLJ SENSOR</h2><button onClick={() => setEditingGaugeIdx(null)} className="p-3"><X /></button></div>
          <div className="flex-1 overflow-y-auto space-y-3 no-scrollbar pb-20">
            {currentAdx?.parameters.map(p => (
              <button key={p.id} onClick={() => {
                const newLib = [...adxLibrary];
                const adxIdx = newLib.findIndex(a => a.id === currentAdxId);
                if (adxIdx !== -1) {
                  newLib[adxIdx].gauges[editingGaugeIdx] = { ...newLib[adxIdx].gauges[editingGaugeIdx], label: p.title, field: p.id, unit: p.units, max: p.title.toUpperCase().includes("RPM") ? 7000 : p.title.toUpperCase().includes("TPS") ? 100 : 255 };
                  setAdxLibrary(newLib);
                }
                setEditingGaugeIdx(null);
              }} className="w-full p-5 bg-white/5 border border-white/10 rounded-2xl text-left flex justify-between items-center active:bg-cyan-500/20 transition-colors"><span className="text-xs font-bold uppercase tracking-tight">{p.title}</span><span className="text-[9px] opacity-30 font-mono">{p.units}</span></button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const NavBtn = ({ active, onClick, icon, label, theme }: any) => (
  <button onClick={onClick} className={`flex flex-col items-center gap-1.5 transition-all flex-1 ${active ? 'opacity-100 scale-110' : 'opacity-20 hover:opacity-40'}`}>
    <div style={{ color: active ? theme.accent : 'white' }}>{React.cloneElement(icon, { size: 18 })}</div>
    <span className="text-[6px] font-black uppercase tracking-[0.2em]">{label}</span>
  </button>
);

export default App;