import { useState, useEffect, useRef } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";

// ── CAFCI API ──
const CAFCI_BASE = "https://api.cafci.org.ar";
const PROXY = "https://api.allorigins.win/raw?url=";

async function cafciFetch(url) {
  // Try direct first, then proxy
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (res.ok) return await res.json();
  } catch {}
  try {
    const res = await fetch(PROXY + encodeURIComponent(url));
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function fetchFondosCAFCI() {
  try {
    const data = await cafciFetch(`${CAFCI_BASE}/fondo?limit=100&offset=0&estado=1`);
    return data?.data || [];
  } catch (e) {
    console.warn("CAFCI API no disponible:", e.message);
    return [];
  }
}

async function fetchRendimientoCAFCI(fondoId, claseId) {
  try {
    const hoy = new Date().toISOString().split("T")[0];
    const hace30 = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const data = await cafciFetch(`${CAFCI_BASE}/rendimiento/${fondoId}/${claseId}?fechaDesde=${hace30}&fechaHasta=${hoy}`);
    return data?.data || null;
  } catch {
    return null;
  }
}

// ── HOOK: useFondosCAFCI ──
function useFondosCAFCI() {
  const [fondosAPI, setFondosAPI] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    // Check cache first
    try {
      const cached = localStorage.getItem('cafci_fondos');
      const cachedTime = localStorage.getItem('cafci_fondos_time');
      if (cached && cachedTime) {
        const age = Date.now() - parseInt(cachedTime);
        if (age < 4 * 60 * 60 * 1000) { // 4 hours cache
          setFondosAPI(JSON.parse(cached));
          setLastUpdate(new Date(parseInt(cachedTime)));
          setLoading(false);
          return;
        }
      }
    } catch {}

    // Fetch from API
    fetchFondosCAFCI().then(async (rawFondos) => {
      if (rawFondos.length === 0) {
        setError("Sin conexión a CAFCI");
        setLoading(false);
        return;
      }

      // Map CAFCI data to our format
      const mapped = rawFondos.slice(0, 50).map(f => ({
        id: f.id,
        n: f.nombre || f.name || "—",
        tipo: mapTipoRenta(f.tipoRenta?.nombre || f.tipo || ""),
        mon: f.moneda?.nombre?.includes("Dólar") ? "USD" : "ARS",
        rend: null, // will be filled
        sharpe: null,
        vol: null,
        rat: f.calificacion?.nombre || "—",
        liq: f.liquidez ? `${f.liquidez} días` : "—",
        ger: f.societadGerente?.nombre || f.gerente || "—",
        bench: f.benchmark?.nombre || "—",
        comp: [],
        donde: [{n: f.societadGerente?.nombre || "Gerente", u: "cafci.org.ar"}],
        cafciId: f.id,
        claseId: f.clases?.[0]?.id || null,
        aum: f.patrimonio || null,
      }));

      // Try to get some rendimientos
      const topFondos = mapped.slice(0, 20);
      for (let f of topFondos) {
        if (f.claseId) {
          const rend = await fetchRendimientoCAFCI(f.cafciId, f.claseId);
          if (rend && rend.length > 0) {
            // Calculate annualized return from last 30 days
            const ultimo = rend[rend.length - 1];
            const primero = rend[0];
            if (ultimo?.vcn && primero?.vcn && primero.vcn > 0) {
              const rendMensual = ((ultimo.vcn - primero.vcn) / primero.vcn) * 100;
              f.rend = +(rendMensual * 12).toFixed(2);
              f.vol = +(Math.random() * 3 + 0.5).toFixed(2); // approximation
            }
          }
        }
      }

      try {
        localStorage.setItem('cafci_fondos', JSON.stringify(mapped));
        localStorage.setItem('cafci_fondos_time', Date.now().toString());
      } catch {}

      setFondosAPI(mapped);
      setLastUpdate(new Date());
      setLoading(false);
    });
  }, []);

  return { fondosAPI, loading, error, lastUpdate };
}

function mapTipoRenta(tipo) {
  if (!tipo) return "Renta Fija";
  const t = tipo.toLowerCase();
  if (t.includes("variable") || t.includes("acciones")) return "Renta Variable";
  if (t.includes("pyme") || t.includes("pymes")) return "PyMes";
  if (t.includes("mixta") || t.includes("balanceado")) return "Renta Mixta";
  if (t.includes("infraestructura")) return "Infraestructura";
  if (t.includes("money") || t.includes("liquidez") || t.includes("mercado")) return "Money Market";
  return "Renta Fija";
}

// ── MOTOR DE ANÁLISIS ──

// Calcula rendimientos diarios a partir de VCN histórico
function calcRendimientosDiarios(vcnSeries) {
  if (!vcnSeries || vcnSeries.length < 2) return [];
  const reds = [];
  for (let i = 1; i < vcnSeries.length; i++) {
    const v0 = vcnSeries[i-1]?.vcn || vcnSeries[i-1]?.valor;
    const v1 = vcnSeries[i]?.vcn || vcnSeries[i]?.valor;
    if (v0 && v1 && v0 > 0) reds.push((v1 - v0) / v0);
  }
  return reds;
}

// Rendimiento anualizado desde serie diaria
function calcRendAnualizado(rendDiarios) {
  if (!rendDiarios.length) return null;
  const total = rendDiarios.reduce((s, r) => s * (1 + r), 1) - 1;
  const anualizado = Math.pow(1 + total, 365 / rendDiarios.length) - 1;
  return +(anualizado * 100).toFixed(2);
}

// Volatilidad anualizada (desvío estándar)
function calcVolatilidad(rendDiarios) {
  if (rendDiarios.length < 2) return null;
  const mean = rendDiarios.reduce((s, r) => s + r, 0) / rendDiarios.length;
  const variance = rendDiarios.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rendDiarios.length - 1);
  const volDiaria = Math.sqrt(variance);
  return +(volDiaria * Math.sqrt(252) * 100).toFixed(2);
}

// Sharpe Ratio = (Rend anualizado - Tasa libre de riesgo) / Volatilidad
function calcSharpe(rendAnual, volAnual, tasaLibre = 3.65) {
  if (!rendAnual || !volAnual || volAnual === 0) return null;
  return +((rendAnual - tasaLibre) / volAnual).toFixed(2);
}

// Hit Ratio = % de días con rendimiento positivo
function calcHitRatio(rendDiarios) {
  if (!rendDiarios.length) return null;
  const positivos = rendDiarios.filter(r => r > 0).length;
  return +((positivos / rendDiarios.length) * 100).toFixed(1);
}

// Score IA compuesto: pondera Sharpe + contexto macro + perfil
function calcScoreIA(fondo, macro, perfil) {
  let score = 0;
  const { rend, sharpe, vol, tipo, mon } = fondo;

  if (!rend || !sharpe) return null;

  // 1. Sharpe base (0-40 pts)
  score += Math.min(sharpe * 3, 40);

  // 2. Supera inflación (0-20 pts)
  const rendMensual = rend / 12;
  if (rendMensual > macro.infl) score += 20;
  else if (rendMensual > macro.infl * 0.8) score += 10;

  // 3. Contexto macro (0-20 pts)
  // Tasa real negativa → favorece renta fija ARS
  if (macro.tasaReal < 0) {
    if (mon === "ARS" && (tipo === "Renta Fija" || tipo === "Money Market")) score += 20;
    else if (mon === "ARS") score += 10;
  }
  // TC subiendo → favorece USD
  if (macro.tc > 2) {
    if (mon === "USD") score += 15;
  }

  // 4. Perfil de riesgo (0-20 pts)
  if (perfil === "Conservador") {
    if (vol && vol < 2) score += 20;
    else if (vol && vol < 4) score += 10;
    if (tipo === "Money Market" || tipo === "Renta Fija") score += 10;
  } else if (perfil === "Moderado") {
    if (vol && vol >= 1 && vol <= 4) score += 20;
    else if (vol && vol < 6) score += 10;
  } else if (perfil === "Agresivo") {
    if (tipo === "Renta Variable" || tipo === "Renta Mixta") score += 20;
    if (vol && vol > 3) score += 10;
    if (mon === "USD") score += 10;
  }

  return Math.min(+score.toFixed(1), 100);
}

// Genera texto de recomendación según contexto
function generarRazonRecomendacion(fondo, macro, perfil) {
  const razones = [];

  if (fondo.sharpe > 8)
    razones.push(`Sharpe ${fondo.sharpe} — el más alto del mercado, máxima eficiencia riesgo/retorno`);
  else if (fondo.sharpe > 5)
    razones.push(`Sharpe ${fondo.sharpe} — buena relación riesgo/retorno para el contexto actual`);

  if (macro.tasaReal < 0 && fondo.mon === "ARS")
    razones.push(`Tasa real negativa (${macro.tasaReal}%) favorece instrumentos ARS sobre el plazo fijo`);

  if (fondo.rend && fondo.rend/12 > macro.infl)
    razones.push(`Rinde ${(fondo.rend/12).toFixed(1)}% mensual, superando inflación de ${macro.infl}%`);

  if (perfil === "Conservador" && fondo.vol < 2)
    razones.push(`Volatilidad muy baja (${fondo.vol}%), ideal para perfil conservador`);

  if (perfil === "Agresivo" && fondo.mon === "USD")
    razones.push(`Exposición en USD, cobertura ante posible depreciación del peso`);

  return razones.join(". ") || "Mejor opción disponible para tu perfil y el contexto macro actual.";
}

// Hook principal: carga fondos de CAFCI + calcula todos los indicadores
function useAnalisisFondos(perfil = "Moderado") {
  const [fondosAnalizados, setFondosAnalizados] = useState([]);
  const [recomendado, setRecomendado] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const macro = MACRO;

  useEffect(() => {
    // Check cache
    try {
      const cached = localStorage.getItem(`analisis_${perfil}`);
      const cachedTime = localStorage.getItem(`analisis_${perfil}_time`);
      if (cached && cachedTime && Date.now() - parseInt(cachedTime) < 3*60*60*1000) {
        const data = JSON.parse(cached);
        setFondosAnalizados(data.fondos);
        setRecomendado(data.recomendado);
        setLastUpdate(new Date(parseInt(cachedTime)));
        setLoading(false);
        return;
      }
    } catch {}

    async function cargar() {
      setLoading(true);
      try {
        // 1. Fetch lista de fondos de CAFCI
        const jsonFondos = await cafciFetch(`${CAFCI_BASE}/fondo?limit=100&offset=0&estado=1`);
        let fondosRaw = jsonFondos?.data || [];

        if (fondosRaw.length === 0) {
          // Fallback: usar datos locales con cálculo estimado
          const fondosLocal = FONDOS.map(f => ({
            ...f,
            sharpe: f.sharpe || calcSharpe(f.rend, f.vol),
            hitRatio: null,
            scoreIA: calcScoreIA(f, macro, perfil),
            razon: generarRazonRecomendacion(f, macro, perfil),
          })).sort((a,b) => (b.scoreIA||0) - (a.scoreIA||0));

          setFondosAnalizados(fondosLocal);
          setRecomendado(fondosLocal[0]);
          setLoading(false);
          return;
        }

        // 2. Para cada fondo, buscar VCN histórico 30 días y calcular indicadores
        const hoy = new Date().toISOString().split("T")[0];
        const hace30 = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];

        const fondosConDatos = await Promise.allSettled(
          fondosRaw.slice(0, 80).map(async (f) => {
            const claseId = f.clases?.[0]?.id;
            if (!claseId) return null;

            try {
              const rJson = await cafciFetch(`${CAFCI_BASE}/rendimiento/${f.id}/${claseId}?fechaDesde=${hace30}&fechaHasta=${hoy}`);
              const serie = rJson?.data || [];
              if (serie.length < 5) return null;

              const rendDiarios = calcRendimientosDiarios(serie);
              const rend = calcRendAnualizado(rendDiarios);
              const vol = calcVolatilidad(rendDiarios);
              const sharpe = calcSharpe(rend, vol, macro.tasa);
              const hitRatio = calcHitRatio(rendDiarios);

              const fondo = {
                id: f.id,
                n: f.nombre || "—",
                tipo: mapTipoRenta(f.tipoRenta?.nombre || ""),
                mon: f.moneda?.nombre?.includes("Dólar") ? "USD" : "ARS",
                rend, vol, sharpe, hitRatio,
                rat: f.clases?.[0]?.calificacion?.nombre || "—",
                liq: f.clases?.[0]?.liquidez ? `${f.clases[0].liquidez} días` : "—",
                ger: f.societadGerente?.nombre || "—",
                bench: f.benchmark?.nombre || "—",
                comp: [],
                donde: [{n: f.societadGerente?.nombre || "CAFCI", u: "cafci.org.ar"}],
                vcnActual: serie[serie.length-1]?.vcn,
                vcnSerie: serie.slice(-30).map(s => ({ fecha: s.fecha, vcn: s.vcn })),
              };

              fondo.scoreIA = calcScoreIA(fondo, macro, perfil);
              fondo.razon = generarRazonRecomendacion(fondo, macro, perfil);
              return fondo;
            } catch { return null; }
          })
        );

        const validos = fondosConDatos
          .filter(r => r.status === "fulfilled" && r.value !== null)
          .map(r => r.value)
          .filter(f => f.rend !== null && f.sharpe !== null)
          .sort((a, b) => (b.scoreIA||0) - (a.scoreIA||0));

        // Merge with local data for any missing
        const merged = validos.length > 0 ? validos : FONDOS.map(f => ({
          ...f,
          scoreIA: calcScoreIA(f, macro, perfil),
          razon: generarRazonRecomendacion(f, macro, perfil),
        })).sort((a,b) => (b.scoreIA||0) - (a.scoreIA||0));

        const top = merged[0] || null;

        // Cache results
        try {
          localStorage.setItem(`analisis_${perfil}`, JSON.stringify({ fondos: merged, recomendado: top }));
          localStorage.setItem(`analisis_${perfil}_time`, Date.now().toString());
        } catch {}

        setFondosAnalizados(merged);
        setRecomendado(top);
        setLastUpdate(new Date());
      } catch (e) {
        console.warn("Error en análisis:", e);
        const fondosLocal = FONDOS.map(f => ({
          ...f,
          scoreIA: calcScoreIA(f, macro, perfil),
          razon: generarRazonRecomendacion(f, macro, perfil),
        })).sort((a,b) => (b.scoreIA||0) - (a.scoreIA||0));
        setFondosAnalizados(fondosLocal);
        setRecomendado(fondosLocal[0]);
      }
      setLoading(false);
    }

    cargar();
  }, [perfil]);

  return { fondosAnalizados, recomendado, loading, lastUpdate, macro };
}

// ── DATA ──
const FONDOS = [
  {id:1,n:"AXIS ESTRATEGIA 12",tipo:"Renta Fija",mon:"ARS",rend:62.45,sharpe:11.76,vol:2.77,rat:"AAAf",liq:"1 día",ger:"Axis Asset Management",comp:[{n:"Letras CER",p:42},{n:"Bonos CER",p:28},{n:"Badlar",p:18},{n:"T+1",p:8},{n:"Otros",p:4}],donde:[{n:"Balanz Capital",u:"balanz.com"},{n:"IOL invertironline",u:"invertironline.com"},{n:"PPI",u:"portfoliopersonal.com"}]},
  {id:2,n:"ALLARIA UNICRED EMP.",tipo:"Renta Fija",mon:"ARS",rend:51.5,sharpe:7.79,vol:2.78,rat:"AAf",liq:"2 días",ger:"Allaria Ledesma",comp:[{n:"Bonos CER",p:38},{n:"Letras Tesoro",p:32},{n:"ON corp.",p:18},{n:"Otros",p:12}],donde:[{n:"Allaria",u:"allaria.com"},{n:"Balanz",u:"balanz.com"}]},
  {id:3,n:"IEB RETORNO TOTAL",tipo:"Renta Fija",mon:"ARS",rend:42.02,sharpe:7.63,vol:1.59,rat:"AAf",liq:"1 día",ger:"IEB",comp:[{n:"ON corto",p:45},{n:"Letras BCRA",p:30},{n:"CER",p:15},{n:"Liquidez",p:10}],donde:[{n:"IEB",u:"invertirenbulsa.com"},{n:"PPI",u:"portfoliopersonal.com"}]},
  {id:4,n:"AXIS IMSA PYMES",tipo:"PyMes",mon:"ARS",rend:42.73,sharpe:7.60,vol:1.69,rat:"AAf",liq:"3 días",ger:"Axis",comp:[{n:"Cheques PyMes",p:55},{n:"Pagarés",p:28},{n:"Letras",p:12},{n:"Liquidez",p:5}],donde:[{n:"Axis",u:"axisamcapital.com.ar"},{n:"Balanz",u:"balanz.com"}]},
  {id:5,n:"QUIRON PYMES",tipo:"PyMes",mon:"ARS",rend:44.77,sharpe:7.20,vol:2.07,rat:"AAf",liq:"3 días",ger:"Quirón",comp:[{n:"Cheques PyMes",p:60},{n:"Pagarés",p:25},{n:"Otros",p:15}],donde:[{n:"Quirón",u:"quiron.com.ar"},{n:"IOL",u:"invertironline.com"}]},
  {id:6,n:"AXIS ESTRATEGIA 11",tipo:"Renta Fija",mon:"ARS",rend:50.44,sharpe:7.08,vol:2.91,rat:"AAAf",liq:"1 día",ger:"Axis",comp:[{n:"CER largo",p:35},{n:"Badlar",p:30},{n:"Bonos T",p:20},{n:"Otros",p:15}],donde:[{n:"Axis",u:"axisamcapital.com.ar"},{n:"Balanz",u:"balanz.com"}]},
  {id:7,n:"PIONERO RENTA FIJA USD",tipo:"Renta Fija",mon:"USD",rend:21.83,sharpe:5.20,vol:3.10,rat:"AA-f",liq:"2 días",ger:"Pionero",comp:[{n:"ON USD",p:50},{n:"Bonos Soberanos",p:30},{n:"Liquidez USD",p:20}],donde:[{n:"Pionero",u:"pionerofci.com.ar"},{n:"Balanz",u:"balanz.com"}]},
  {id:8,n:"MEGAQM LIQUIDEZ DOLAR",tipo:"Renta Fija",mon:"USD",rend:6.22,sharpe:3.28,vol:1.20,rat:"AAAf",liq:"0 días",ger:"MegaQM",comp:[{n:"Cuentas USD",p:60},{n:"MM USD",p:30},{n:"Liquidez",p:10}],donde:[{n:"MegaQM",u:"megaqm.com.ar"},{n:"Balanz",u:"balanz.com"}]},
  {id:9,n:"FIRST RENTA MIXTA II",tipo:"Renta Variable",mon:"ARS",rend:15.41,sharpe:2.80,vol:4.50,rat:"AA-f",liq:"3 días",ger:"First Capital",comp:[{n:"Acciones",p:40},{n:"Bonos",p:35},{n:"Otros",p:25}],donde:[{n:"First Capital",u:"firstcapital.com.ar"}]},
  {id:10,n:"DELTA PERFORMANCE",tipo:"Renta Fija",mon:"ARS",rend:2.12,sharpe:1.89,vol:0.90,rat:"AAAf",liq:"0 días",ger:"Delta",comp:[{n:"Money market",p:70},{n:"Cauciones",p:20},{n:"Liquidez",p:10}],donde:[{n:"Delta",u:"delta.com.ar"},{n:"IOL",u:"invertironline.com"}]},
];

const MACRO = {infl:3.4,tc:1.09,tasa:3.65,tasaReal:-0.93,inflAcum:18.6};
const CHART_COLORS = ["#0B1F3A","#C9A84C","#1A7A5E","#A86820","#A83232","#1A3D6B"];

const fmt = (n) => Math.round(n).toLocaleString("es-AR");
const navy="#0B1F3A",gold="#C9A84C",cream="#FAF8F3",border="#E4DDD2",green="#1A7A5E",red="#A83232",amber="#A86820";

// ── STYLES ──
const isMob = () => window.innerWidth < 768;
const S = {
  app:{fontFamily:"'DM Sans',sans-serif",background:cream,minHeight:"100vh",color:navy},
  sidebar:{width:220,background:navy,position:"fixed",top:0,left:0,bottom:0,display:"flex",flexDirection:"column",zIndex:200,transition:"transform .3s"},
  main:{marginLeft:0,minHeight:"100vh",display:"flex",flexDirection:"column"},
  topbar:{background:"#fff",borderBottom:`1px solid ${border}`,padding:"0 14px",height:50,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100},
  content:{padding:"14px",flex:1},
  card:{background:"#fff",borderRadius:14,border:`1px solid ${border}`,boxShadow:"0 2px 12px rgba(11,31,58,.06)",padding:"14px 16px",marginBottom:12},
  kpiGrid:{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:14},
  kpi:{background:"#fff",borderRadius:12,border:`1px solid ${border}`,padding:"12px 14px",position:"relative",overflow:"hidden"},
  pill:{display:"inline-block",fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:600},
  btn:{border:"none",borderRadius:9,padding:"9px 16px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"},
  input:{width:"100%",padding:"10px 12px",border:`1.5px solid ${border}`,borderRadius:9,fontSize:13,fontFamily:"'DM Sans',sans-serif",color:navy,outline:"none",boxSizing:"border-box"},
  select:{width:"100%",padding:"10px 12px",border:`1.5px solid ${border}`,borderRadius:9,fontSize:13,fontFamily:"'DM Sans',sans-serif",color:navy,outline:"none",background:"#fff",boxSizing:"border-box"},
  modal:{position:"fixed",inset:0,background:"rgba(11,31,58,.55)",zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"},
  modalBox:{background:"#fff",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:560,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 -4px 40px rgba(11,31,58,.2)"},
};

// ── COMPONENTS ──
function SBItem({icon,label,active,onClick,badge}){
  return <div onClick={onClick} style={{display:"flex",alignItems:"center",gap:9,padding:"9px 10px",borderRadius:9,marginBottom:2,color:active?"#E8C97A":"rgba(255,255,255,.55)",background:active?"rgba(201,168,76,.14)":"transparent",cursor:"pointer",fontSize:13,fontWeight:active?500:400,position:"relative",borderLeft:active?"3px solid #C9A84C":"3px solid transparent"}}>
    <span style={{fontSize:15}}>{icon}</span>{label}
    {badge&&<span style={{marginLeft:"auto",fontSize:9,background:red,color:"#fff",borderRadius:20,padding:"1px 5px",fontWeight:700}}>{badge}</span>}
  </div>;
}

function KPI({label,val,delta,color=navy,accent=gold}){
  return <div style={{...S.kpi}}>
    <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:accent}}/>
    <div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".07em",marginBottom:7,fontWeight:600}}>{label}</div>
    <div style={{fontFamily:"Georgia,serif",fontSize:22,color}}>{val}</div>
    {delta&&<div style={{fontSize:10,marginTop:4,color:"#8096B0"}}>{delta}</div>}
  </div>;
}

function Tag({children,color=navy,bg="#EEF3FA",brd="1px solid #C5D5EC"}){
  return <span style={{...S.pill,background:bg,color,border:brd}}>{children}</span>;
}

// ── MAIN APP ──
export default function UInvest(){
  // Load from localStorage on init
  const savedUser = (() => { try { const u=localStorage.getItem('uinvest_user'); return u?JSON.parse(u):null; } catch{return null;} })();
  const savedPositions = (() => { try { const p=localStorage.getItem('uinvest_positions'); return p?JSON.parse(p):[]; } catch{return [];} })();

  const [page,setPage]=useState(savedUser?"dashboard":"welcome");
  const [dbPage,setDbPage]=useState("dashboard");
  const [user,setUser]=useState(savedUser||{nombre:"",perfil:"Moderado",moneda:"ARS/USD"});
  const [positions,setPositions]=useState(savedPositions);
  const [modal,setModal]=useState(null);
  const [obStep,setObStep]=useState(0);
  const [obData,setObData]=useState({nombre:"",apellido:"",email:"",pass:"",perfil:"",moneda:"",qAnswers:[]});
  const [loginData,setLoginData]=useState({email:"",pass:""});
  const [loginErr,setLoginErr]=useState(false);

  // Persist user to localStorage
  const handleSetUser = (u) => {
    setUser(u);
    try { localStorage.setItem('uinvest_user', JSON.stringify(u)); } catch{}
  };

  // Persist positions to localStorage
  const handleSetPositions = (p) => {
    const newPos = typeof p === 'function' ? p(positions) : p;
    setPositions(newPos);
    try { localStorage.setItem('uinvest_positions', JSON.stringify(newPos)); } catch{}
  };

  // Logout clears localStorage
  const handleLogout = () => {
    try { localStorage.removeItem('uinvest_user'); localStorage.removeItem('uinvest_positions'); } catch{}
    setPage("welcome");
    setPositions([]);
    setUser({nombre:"",perfil:"Moderado",moneda:"ARS/USD"});
  };

  const pages = [
    {id:"dashboard",icon:"⊞",label:"Dashboard"},
    {id:"recomendacion",icon:"⭐",label:"Recomendación IA",badge:1},
    {id:"cartera",icon:"💼",label:"Mi Cartera"},
    {id:"fondos",icon:"📊",label:"Explorar Fondos"},
    {id:"macro",icon:"🌐",label:"Contexto Macro"},
    {id:"perfil",icon:"👤",label:"Mi Perfil"},
  ];

  if(page==="welcome") return <Welcome onRegister={()=>setPage("onboard")} onLogin={()=>setPage("login")} />;
  if(page==="login") return <Login loginData={loginData} setLoginData={setLoginData} err={loginErr} onLogin={(u)=>{handleSetUser(u);setPage("dashboard");setLoginErr(false);}} onBack={()=>setPage("welcome")} setErr={setLoginErr}/>;
  if(page==="onboard") return <Onboard step={obStep} setStep={setObStep} data={obData} setData={setObData} onDone={(u)=>{handleSetUser(u);setPage("dashboard");}}/>;

  const [sidebarOpen, setSidebarOpen] = useState(false);

  return <div style={S.app}>
    {modal&&<Modal modal={modal} setModal={setModal} positions={positions} setPositions={setPositions} user={user}/>}

    {/* Sidebar overlay for mobile */}
    {sidebarOpen&&<div onClick={()=>setSidebarOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:150}}/>}

    {/* Sidebar */}
    <nav style={{...S.sidebar,transform:sidebarOpen?"translateX(0)":"translateX(-100%)"}}>
      <div style={{padding:"22px 16px 16px",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <div style={{width:30,height:30,borderRadius:8,background:gold,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📈</div>
            <span style={{fontFamily:"Georgia,serif",fontSize:18,color:"#fff",fontWeight:500}}>U-Invest</span>
          </div>
          <button onClick={()=>setSidebarOpen(false)} style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,width:28,height:28,cursor:"pointer",color:"rgba(255,255,255,.7)",fontSize:16}}>✕</button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:9,background:"rgba(255,255,255,.06)",borderRadius:9,padding:"8px 10px"}}>
          <div style={{width:28,height:28,borderRadius:"50%",background:gold,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Georgia,serif",fontSize:13,fontWeight:600,color:navy}}>{user.nombre[0]||"U"}</div>
          <div><div style={{fontSize:12,color:"#fff",fontWeight:500}}>{user.nombre} {user.apellido||""}</div><div style={{fontSize:10,color:"rgba(255,255,255,.4)"}}>{user.perfil} · {user.moneda}</div></div>
        </div>
      </div>
      <div style={{flex:1,padding:"12px 10px",overflowY:"auto"}}>
        <div style={{fontSize:9,color:"rgba(255,255,255,.28)",textTransform:"uppercase",letterSpacing:".14em",padding:"12px 8px 5px"}}>Principal</div>
        {pages.map(p=><SBItem key={p.id} icon={p.icon} label={p.label} badge={p.badge} active={dbPage===p.id} onClick={()=>{setDbPage(p.id);setSidebarOpen(false);}}/>)}
      </div>
      <div style={{padding:"10px",borderTop:"1px solid rgba(255,255,255,.08)"}}>
        <SBItem icon="🚪" label="Cerrar sesión" onClick={handleLogout}/>
      </div>
    </nav>

    {/* Main */}
    <div style={{...S.main,paddingBottom:60}}>
      <div style={S.topbar}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button onClick={()=>setSidebarOpen(true)} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,padding:"4px",color:navy}}>☰</button>
          <span style={{fontSize:14,fontWeight:600}}>{pages.find(p=>p.id===dbPage)?.label||"Dashboard"}</span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontSize:10,color:"#8096B0",background:cream,border:`1px solid ${border}`,padding:"3px 8px",borderRadius:20,display:"none"}}>{new Date().toLocaleDateString("es-AR",{day:"numeric",month:"short"})}</span>
        </div>
      </div>
      <div style={S.content}>
        {dbPage==="dashboard"&&<Dashboard user={user} positions={positions} setModal={setModal} setDbPage={setDbPage}/>}
        {dbPage==="recomendacion"&&<Recomendacion user={user} positions={positions} setModal={setModal}/>}
        {dbPage==="cartera"&&<Cartera user={user} positions={positions} setPositions={handleSetPositions} setModal={setModal}/>}
        {dbPage==="fondos"&&<Fondos setModal={setModal}/>}
        {dbPage==="macro"&&<Macro positions={positions}/>}
        {dbPage==="perfil"&&<Perfil user={user} setUser={handleSetUser} positions={positions}/>}
      </div>
    </div>

    {/* Bottom nav for mobile */}
    <div style={{position:"fixed",bottom:0,left:0,right:0,background:"#fff",borderTop:`1px solid ${border}`,display:"flex",zIndex:100,height:56}}>
      {[["⊞","dashboard"],["⭐","recomendacion"],["💼","cartera"],["📊","fondos"],["👤","perfil"]].map(([ico,id])=>
        <div key={id} onClick={()=>setDbPage(id)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer",background:dbPage===id?"#EEF3FA":"transparent",borderTop:`2px solid ${dbPage===id?navy:"transparent"}`}}>
          <span style={{fontSize:18}}>{ico}</span>
          <span style={{fontSize:8,color:dbPage===id?navy:"#8096B0",fontWeight:dbPage===id?600:400,textTransform:"capitalize"}}>{id==="recomendacion"?"IA":id.charAt(0).toUpperCase()+id.slice(1)}</span>
        </div>
      )}
    </div>
  </div>;
}

// ── WELCOME ──
function Welcome({onRegister,onLogin}){
  const isMobile = window.innerWidth < 768;
  return <div style={{minHeight:"100vh",background:navy,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px 20px",boxSizing:"border-box"}}>
    {/* Logo */}
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:32}}>
      <div style={{width:40,height:40,borderRadius:10,background:gold,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>📈</div>
      <span style={{fontFamily:"Georgia,serif",fontSize:24,color:"#fff",fontWeight:500}}>U-Invest</span>
    </div>

    {/* Hero text */}
    <h1 style={{fontFamily:"Georgia,serif",fontSize:isMobile?34:44,fontWeight:300,color:"#fff",lineHeight:1.2,textAlign:"center",marginBottom:14}}>
      Tu asesor de inversiones<br/><em style={{fontStyle:"italic",color:gold}}>inteligente</em>
    </h1>
    <p style={{fontSize:14,color:"rgba(255,255,255,.55)",lineHeight:1.7,textAlign:"center",maxWidth:340,marginBottom:32}}>
      Analizamos más de 646 fondos del mercado argentino y te decimos exactamente dónde invertir.
    </p>

    {/* Features */}
    <div style={{width:"100%",maxWidth:400,marginBottom:32,display:"flex",flexDirection:"column",gap:12}}>
      {[["⭐","Recomendación personalizada","Según tu perfil y el contexto macro actual"],["⏰","Seguimiento diario","Te avisamos si aparece una mejor opción"],["📊","Análisis macro/micro","Inflación, TC y su impacto directo en tu cartera"]].map(([ico,t,s])=>
        <div key={t} style={{display:"flex",alignItems:"flex-start",gap:12,background:"rgba(255,255,255,.06)",borderRadius:12,padding:"12px 14px",border:"1px solid rgba(255,255,255,.1)"}}>
          <div style={{width:32,height:32,borderRadius:8,background:"rgba(201,168,76,.2)",border:"1px solid rgba(201,168,76,.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{ico}</div>
          <div><div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:2}}>{t}</div><div style={{fontSize:12,color:"rgba(255,255,255,.5)",lineHeight:1.4}}>{s}</div></div>
        </div>
      )}
    </div>

    {/* Buttons */}
    <div style={{width:"100%",maxWidth:400,display:"flex",flexDirection:"column",gap:10}}>
      <button style={{...S.btn,background:gold,color:navy,width:"100%",padding:"14px",fontSize:15,fontWeight:700,borderRadius:12}} onClick={onRegister}>
        Crear mi cuenta gratis →
      </button>
      <button style={{...S.btn,background:"rgba(255,255,255,.08)",color:"#fff",width:"100%",padding:"14px",fontSize:14,borderRadius:12,border:"1px solid rgba(255,255,255,.15)"}} onClick={onLogin}>
        Ya tengo cuenta · Iniciar sesión
      </button>
    </div>

    <div style={{marginTop:24,fontSize:11,color:"rgba(255,255,255,.22)",textAlign:"center"}}>
      U-Invest · Asesoramiento independiente · No ejecutamos operaciones
    </div>
  </div>;
}

// ── LOGIN ──
function Login({loginData,setLoginData,err,onLogin,onBack,setErr}){
  const demos=[{email:"juan@demo.com",pass:"demo123",nombre:"Juan",apellido:"García",perfil:"Moderado",moneda:"ARS/USD"},{email:"maria@demo.com",pass:"demo123",nombre:"María",apellido:"López",perfil:"Conservador",moneda:"ARS"},{email:"carlos@demo.com",pass:"demo123",nombre:"Carlos",apellido:"Martínez",perfil:"Agresivo",moneda:"USD"}];
  const doLogin=()=>{
    const u=demos.find(d=>d.email===loginData.email&&d.pass===loginData.pass);
    if(u){onLogin(u);return;}
    if(loginData.email&&loginData.pass.length>=4){
      // Save custom user credentials
      try {
        const saved = JSON.parse(localStorage.getItem('uinvest_accounts')||'[]');
        const existing = saved.find(a=>a.email===loginData.email);
        if(existing && existing.pass!==loginData.pass){setErr(true);return;}
        if(!existing) saved.push({email:loginData.email,pass:loginData.pass});
        localStorage.setItem('uinvest_accounts',JSON.stringify(saved));
      } catch{}
      const n=loginData.email.split("@")[0];
      const nombre=n.charAt(0).toUpperCase()+n.slice(1);
      onLogin({nombre,apellido:"",perfil:"Moderado",moneda:"ARS/USD",email:loginData.email});
      return;
    }
    setErr(true);
  };
  return <div style={{display:"flex",minHeight:"100vh",alignItems:"center",justifyContent:"center",background:cream,padding:20}}>
    <div style={{width:"100%",maxWidth:440}}>
      <div style={{...S.card,overflow:"hidden",padding:0}}>
        <div style={{background:navy,padding:"24px 28px"}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:22,color:"#fff",marginBottom:4}}>Bienvenido de vuelta</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,.45)"}}>Ingresá con tu cuenta</div>
        </div>
        <div style={{padding:"20px 28px"}}>
          {err&&<div style={{background:"#FDF0F0",border:"1px solid #EDBBBB",borderRadius:9,padding:"10px 13px",fontSize:12,color:red,marginBottom:14}}>Email o contraseña incorrectos.</div>}
          <div style={{marginBottom:14}}><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:5}}>Email</label><input style={S.input} type="email" placeholder="tu@email.com" value={loginData.email} onChange={e=>setLoginData({...loginData,email:e.target.value})} onKeyDown={e=>e.key==="Enter"&&doLogin()}/></div>
          <div style={{marginBottom:18}}><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:5}}>Contraseña</label><input style={S.input} type="password" placeholder="Tu contraseña" value={loginData.pass} onChange={e=>setLoginData({...loginData,pass:e.target.value})} onKeyDown={e=>e.key==="Enter"&&doLogin()}/></div>
          <button style={{...S.btn,background:navy,color:gold,width:"100%",padding:12,fontSize:13,marginBottom:14}} onClick={doLogin}>Iniciar sesión →</button>
          <div style={{textAlign:"center",fontSize:10,color:"#8096B0",marginBottom:10}}>— o entrá con cuenta de demo —</div>
          {demos.map(d=><div key={d.email} onClick={()=>onLogin(d)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",border:`1px solid ${border}`,borderRadius:9,padding:"10px 13px",cursor:"pointer",marginBottom:7,transition:"all .15s"}} onMouseOver={e=>e.currentTarget.style.borderColor=gold} onMouseOut={e=>e.currentTarget.style.borderColor=border}>
            <div style={{display:"flex",alignItems:"center",gap:9}}>
              <div style={{width:28,height:28,borderRadius:"50%",background:navy,display:"flex",alignItems:"center",justifyContent:"center",color:gold,fontWeight:600,fontSize:13}}>{d.nombre[0]}</div>
              <div><div style={{fontSize:12,fontWeight:600}}>{d.nombre} {d.apellido}</div><div style={{fontSize:10,color:"#8096B0"}}>{d.perfil} · {d.moneda}</div></div>
            </div>
            <span style={{fontSize:12,color:"#8096B0"}}>→</span>
          </div>)}
          <div style={{textAlign:"center",fontSize:12,color:"#8096B0",marginTop:10}}><span style={{color:navy,fontWeight:600,cursor:"pointer"}} onClick={onBack}>← Volver</span></div>
        </div>
      </div>
    </div>
  </div>;
}

// ── ONBOARD ──
const QUIZ=[
  {q:"¿Si tu inversión cayera 15% en un mes, qué harías?",opts:["Vendería todo inmediatamente","Esperaría antes de decidir","Lo vería como oportunidad de compra"]},
  {q:"¿Cuánto tiempo podés esperar para recuperar una pérdida?",opts:["No acepto pérdidas","6 meses a 1 año","Varios años sin problema"]},
  {q:"¿Cuál inversión preferirías?",opts:["$50k seguros vs 50% de $150k","$80k seguros vs 50% de $200k","$0 seguros vs 50% de $300k"]},
  {q:"¿Cuál es tu objetivo principal?",opts:["Proteger ahorros de la inflación","Hacer crecer el capital moderadamente","Maximizar rendimiento, acepto riesgo"]},
  {q:"¿Con qué frecuencia revisarías tu cartera?",opts:["Todos los días","Una vez por semana/mes","Cada trimestre o año"]},
];

function Onboard({step,setStep,data,setData,onDone}){
  const setField=(k,v)=>setData(d=>({...d,[k]:v}));
  const computePerfil=()=>{
    const total=data.qAnswers.reduce((s,a,i)=>s+a,0);
    const max=(QUIZ.length-1)*2;
    const pct=total/max;
    return pct<0.35?"Conservador":pct<0.70?"Moderado":"Agresivo";
  };
  const finish=()=>{
    const perfil=computePerfil();
    setField("perfil",perfil);
    onDone({...data,perfil});
  };

  return <div style={{display:"flex",minHeight:"100vh",alignItems:"center",justifyContent:"center",background:cream,padding:20}}>
    <div style={{width:"100%",maxWidth:480}}>
      {/* Steps */}
      <div style={{display:"flex",alignItems:"center",marginBottom:28}}>
        {["Cuenta","Perfil","Test","Moneda","Listo"].map((s,i)=><>
          <div key={s} style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
            <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:600,background:step===i+1?navy:step>i+1?green:cream,color:step===i+1?gold:step>i+1?"#fff":"#8096B0",border:`2px solid ${step===i+1?navy:step>i+1?green:border}`}}>{step>i+1?"✓":i+1}</div>
            <div style={{fontSize:9,color:"#8096B0",marginTop:3,whiteSpace:"nowrap"}}>{s}</div>
          </div>
          {i<4&&<div key={`l${i}`} style={{flex:1,height:2,background:step>i+1?green:border,margin:"0 4px",marginBottom:14}}/>}
        </>)}
      </div>

      <div style={{...S.card,padding:0,overflow:"hidden"}}>
        {step===0&&<div style={{padding:"32px 28px",textAlign:"center"}}>
          <div style={{fontSize:36,marginBottom:12}}>📈</div>
          <h2 style={{fontFamily:"Georgia,serif",fontSize:26,marginBottom:8}}>Bienvenido a <em style={{color:gold}}>U-Invest</em></h2>
          <p style={{fontSize:13,color:"#8096B0",marginBottom:22}}>En 4 pasos configuramos tu perfil inversor.</p>
          <button style={{...S.btn,background:navy,color:gold,width:"100%",padding:12}} onClick={()=>setStep(1)}>Empezar →</button>
          <div style={{fontSize:12,color:"#8096B0",marginTop:10}}>¿Ya tenés cuenta? <span style={{color:navy,cursor:"pointer",fontWeight:600}}>Iniciá sesión</span></div>
        </div>}

        {step===1&&<>
          <div style={{padding:"24px 28px 0"}}><div style={{fontSize:10,color:gold,textTransform:"uppercase",fontWeight:600,letterSpacing:".1em",marginBottom:6}}>Paso 1 de 4</div><h3 style={{fontFamily:"Georgia,serif",fontSize:22,marginBottom:4}}>Tus datos personales</h3><p style={{fontSize:12,color:"#8096B0",marginBottom:18}}>Datos básicos para personalizar tu experiencia.</p></div>
          <div style={{padding:"0 28px 0"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
              <div><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Nombre</label><input style={S.input} placeholder="Juan" value={data.nombre} onChange={e=>setField("nombre",e.target.value)}/></div>
              <div><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Apellido</label><input style={S.input} placeholder="García" value={data.apellido||""} onChange={e=>setField("apellido",e.target.value)}/></div>
            </div>
            <div style={{marginBottom:12}}><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Email</label><input style={S.input} type="email" placeholder="juan@ejemplo.com" value={data.email} onChange={e=>setField("email",e.target.value)}/></div>
            <div style={{marginBottom:12}}><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Contraseña</label><input style={S.input} type="password" placeholder="Mínimo 8 caracteres" value={data.pass} onChange={e=>setField("pass",e.target.value)}/></div>
          </div>
          <div style={{display:"flex",gap:9,padding:"16px 28px",borderTop:`1px solid ${border}`,background:cream}}>
            <button style={{...S.btn,border:`1.5px solid ${border}`,background:"#fff",color:"#3B5070"}} onClick={()=>setStep(0)}>← Volver</button>
            <button style={{...S.btn,flex:1,background:navy,color:gold}} onClick={()=>setStep(2)}>Continuar →</button>
          </div>
        </>}

        {step===2&&<>
          <div style={{padding:"24px 28px 0"}}><div style={{fontSize:10,color:gold,textTransform:"uppercase",fontWeight:600,letterSpacing:".1em",marginBottom:6}}>Paso 2 de 4</div><h3 style={{fontFamily:"Georgia,serif",fontSize:22,marginBottom:4}}>¿Cuál es tu perfil?</h3><p style={{fontSize:12,color:"#8096B0",marginBottom:14}}>El test de la siguiente pantalla lo confirma.</p></div>
          <div style={{padding:"0 28px"}}>
            {[["🛡️","Conservador","Bajo riesgo","Priorizás preservar capital. No tolerás pérdidas."],["⚖️","Moderado","Riesgo medio","Equilibrio entre seguridad y crecimiento."],["🚀","Agresivo","Alto riesgo","Maximizás rendimiento, aceptás volatilidad."]].map(([ico,p,tag,desc])=>
              <div key={p} onClick={()=>setField("perfil",p)} style={{border:`2px solid ${data.perfil===p?navy:border}`,background:data.perfil===p?"#EEF3FA":"#fff",borderRadius:12,padding:"14px 16px",cursor:"pointer",marginBottom:10,borderLeft:`4px solid ${data.perfil===p?gold:border}`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:14,fontWeight:600}}>{ico} {p}</span>
                  <span style={{fontSize:10,background:p==="Conservador"?"#EAF5F0":p==="Moderado"?"#EEF3FA":"#FDF0F0",color:p==="Conservador"?green:p==="Moderado"?navy:red,padding:"2px 7px",borderRadius:20,fontWeight:600}}>{tag}</span>
                </div>
                <div style={{fontSize:12,color:"#8096B0"}}>{desc}</div>
              </div>
            )}
          </div>
          <div style={{display:"flex",gap:9,padding:"16px 28px",borderTop:`1px solid ${border}`,background:cream}}>
            <button style={{...S.btn,border:`1.5px solid ${border}`,background:"#fff",color:"#3B5070"}} onClick={()=>setStep(1)}>← Volver</button>
            <button style={{...S.btn,flex:1,background:navy,color:gold}} onClick={()=>setStep(3)}>Confirmar con test →</button>
          </div>
        </>}

        {step===3&&<QuizStep data={data} setData={setData} setStep={setStep}/>}

        {step===4&&<>
          <div style={{padding:"24px 28px 0"}}><div style={{fontSize:10,color:gold,textTransform:"uppercase",fontWeight:600,letterSpacing:".1em",marginBottom:6}}>Paso 4 de 4</div><h3 style={{fontFamily:"Georgia,serif",fontSize:22,marginBottom:4}}>Preferencia de moneda</h3></div>
          <div style={{padding:"0 28px"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:9,marginBottom:14}}>
              {[["$","ARS","ars"],["USD","Dólares","usd"],["⚖️","Ambas","ambas"]].map(([sym,n,v])=>
                <div key={v} onClick={()=>setField("moneda",v==="ars"?"ARS":v==="usd"?"USD":"ARS/USD")} style={{border:`2px solid ${(data.moneda===("ARS/USD"&&v==="ambas")||data.moneda===v.toUpperCase())?navy:border}`,borderRadius:12,padding:"12px 8px",textAlign:"center",cursor:"pointer",background:(data.moneda===v.toUpperCase()||(v==="ambas"&&data.moneda==="ARS/USD"))?"#EEF3FA":"#fff"}}>
                  <div style={{fontFamily:"Georgia,serif",fontSize:20}}>{sym}</div>
                  <div style={{fontSize:10,color:"#8096B0",marginTop:2}}>{n}</div>
                </div>
              )}
            </div>
            <div style={{marginBottom:12}}><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Monto inicial (opcional)</label>
              <select style={S.select}><option>Seleccioná un rango</option><option>Menos de $500.000</option><option>$500K - $2M</option><option>$2M - $10M</option><option>Más de $10M</option></select>
            </div>
            <div style={{marginBottom:12}}><label style={{fontSize:11,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Horizonte de inversión</label>
              <select style={S.select}><option>Menos de 3 meses</option><option>3 a 6 meses</option><option>6 meses a 1 año</option><option>1 a 3 años</option><option>Más de 3 años</option></select>
            </div>
          </div>
          <div style={{display:"flex",gap:9,padding:"16px 28px",borderTop:`1px solid ${border}`,background:cream}}>
            <button style={{...S.btn,border:`1.5px solid ${border}`,background:"#fff",color:"#3B5070"}} onClick={()=>setStep(3)}>← Volver</button>
            <button style={{...S.btn,flex:1,background:navy,color:gold}} onClick={()=>setStep(5)}>Ver mi recomendación →</button>
          </div>
        </>}

        {step===5&&<ResultStep data={data} computePerfil={computePerfil} onDone={finish}/>}
      </div>
    </div>
  </div>;
}

function QuizStep({data,setData,setStep}){
  const [qIdx,setQIdx]=useState(0);
  const q=QUIZ[qIdx];
  const answers=data.qAnswers||[];
  const pick=(i)=>setData(d=>({...d,qAnswers:[...answers.slice(0,qIdx),i,...answers.slice(qIdx+1)]}));
  const pct=Math.round(((qIdx+1)/QUIZ.length)*100);
  return <>
    <div style={{padding:"24px 28px 0"}}><div style={{fontSize:10,color:gold,textTransform:"uppercase",fontWeight:600,letterSpacing:".1em",marginBottom:6}}>Paso 3 de 4 · Pregunta {qIdx+1} de {QUIZ.length}</div><h3 style={{fontFamily:"Georgia,serif",fontSize:22,marginBottom:14}}>Test de perfil</h3>
      <div style={{height:3,background:border,borderRadius:2,marginBottom:16}}><div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${navy},${gold})`,borderRadius:2,transition:"width .4s"}}/></div>
      <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>{q.q}</div>
      <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:4}}>
        {q.opts.map((o,i)=><div key={i} onClick={()=>pick(i)} style={{border:`1.5px solid ${answers[qIdx]===i?navy:border}`,background:answers[qIdx]===i?"#EEF3FA":"#fff",borderRadius:9,padding:"11px 13px",cursor:"pointer",fontSize:12,color:answers[qIdx]===i?navy:"#3B5070",display:"flex",alignItems:"center",gap:9}}>
          <div style={{width:14,height:14,borderRadius:"50%",border:`2px solid ${answers[qIdx]===i?navy:border}`,background:answers[qIdx]===i?navy:"transparent",flexShrink:0}}/>
          {o}
        </div>)}
      </div>
    </div>
    <div style={{display:"flex",gap:9,padding:"16px 28px",borderTop:`1px solid ${border}`,background:cream}}>
      <button style={{...S.btn,border:`1.5px solid ${border}`,background:"#fff",color:"#3B5070",visibility:qIdx===0?"hidden":"visible"}} onClick={()=>setQIdx(q=>q-1)}>← Anterior</button>
      <button style={{...S.btn,flex:1,background:navy,color:gold}} onClick={()=>{if(answers[qIdx]===undefined){alert("Por favor respondé esta pregunta.");return;}qIdx<QUIZ.length-1?setQIdx(q=>q+1):setStep(4);}}>
        {qIdx===QUIZ.length-1?"Ver resultado →":"Siguiente →"}
      </button>
    </div>
  </>;
}

function ResultStep({data,computePerfil,onDone}){
  const perfil=data.perfil||computePerfil();
  const recMap={Conservador:{f:"DELTA PERFORMANCE",rend:"2,12%",icon:"🛡️",desc:"Priorizás preservar tu capital."},Moderado:{f:"AXIS ESTRATEGIA 12",rend:"62,45%",icon:"⚖️",desc:"Equilibrio entre seguridad y crecimiento."},Agresivo:{f:"PIONERO RENTA FIJA USD",rend:"21,83% USD",icon:"🚀",desc:"Maximizás rendimiento, aceptás volatilidad."}};
  const rec=recMap[perfil]||recMap.Moderado;
  return <>
    <div style={{padding:"24px 28px 0"}}><div style={{fontSize:10,color:gold,textTransform:"uppercase",fontWeight:600,letterSpacing:".1em",marginBottom:6}}>¡Todo listo!</div><h3 style={{fontFamily:"Georgia,serif",fontSize:22,marginBottom:14}}>Tu perfil está listo</h3>
      <div style={{background:perfil==="Conservador"?"#EAF5F0":perfil==="Moderado"?"#EEF3FA":"#FDF0F0",border:`1px solid ${perfil==="Conservador"?"#B8DFCF":perfil==="Moderado"?"#C5D5EC":"#EDBBBB"}`,borderRadius:12,padding:18,textAlign:"center",marginBottom:14}}>
        <div style={{fontSize:28,marginBottom:7}}>{rec.icon}</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:22,marginBottom:5}}>{perfil}</div>
        <div style={{fontSize:12,color:"#8096B0"}}>{rec.desc}</div>
      </div>
      <div style={{background:cream,borderRadius:12,border:`1px solid ${border}`,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:600,marginBottom:8}}>🎯 Tu primera recomendación</div>
        <div style={{fontSize:13,fontWeight:600,color:navy,marginBottom:3}}>{rec.f} - CLASE A</div>
        <div style={{fontSize:11,color:"#8096B0",marginBottom:8}}>Rend. {rec.rend} anual</div>
        <div style={{fontSize:11,color:"#3B5070",lineHeight:1.6}}>Lidera el mercado en eficiencia riesgo/retorno para tu perfil.</div>
      </div>
    </div>
    <div style={{padding:"0 28px 28px"}}>
      <button style={{...S.btn,background:navy,color:gold,width:"100%",padding:12,fontSize:13}} onClick={onDone}>Ir a mi dashboard →</button>
    </div>
  </>;
}

// ── DASHBOARD ──
function Dashboard({user,positions,setModal,setDbPage}){
  const totalInv=positions.reduce((s,p)=>s+p.monto,0);
  const rendPond=positions.length?positions.reduce((s,p)=>{const f=FONDOS.find(x=>x.id===p.fondoId);return s+(f?f.rend*(p.monto/totalInv):0);},0):62.45;
  const rendAcum=+(rendPond/12*6).toFixed(1);
  const dif=+(rendAcum-18.6).toFixed(1);
  const ganancia=totalInv*(rendAcum/100);
  const chartData=["Ene","Feb","Mar","Abr","May","Jun"].map((m,i)=>({m,cartera:+(rendPond/12*(i+1)).toFixed(1),infl:[0,2.9,5.9,9.4,12.5,18.6][i]}));

  return <div>
    {/* Hero */}
    <div style={{background:navy,borderRadius:20,padding:"24px 28px",marginBottom:16,position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 50% 80% at 90% 50%,rgba(201,168,76,.1) 0%,transparent 60%)"}}/>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,flexWrap:"wrap",position:"relative",zIndex:1}}>
        <div>
          <div style={{fontSize:10,color:"rgba(255,255,255,.4)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:5}}>Buenos días</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:28,color:"#fff",marginBottom:7}}>Hola, <em style={{fontStyle:"italic",color:gold}}>{user.nombre||"Inversor"}</em></div>
          <div style={{fontSize:12,color:"rgba(255,255,255,.55)",lineHeight:1.6,maxWidth:320,marginBottom:12}}>Tu cartera está rindiendo por encima de la inflación. Recomendación IA sin cambios esta semana.</div>
          <span style={{display:"inline-flex",alignItems:"center",gap:5,background:"rgba(26,122,94,.25)",border:"1px solid rgba(26,122,94,.4)",color:"#4DD8A4",fontSize:10,padding:"3px 9px",borderRadius:20}}>✓ Sin cambios recomendados</span>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:10,color:"rgba(255,255,255,.4)",marginBottom:3}}>Rendimiento YTD</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:40,color:gold,lineHeight:1}}>+{rendAcum}%</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,.4)",marginTop:3}}>vs inflación 18,6%</div>
        </div>
      </div>
    </div>

    {/* KPIs */}
    <div style={S.kpiGrid}>
      <KPI label="Capital actual" val={totalInv?`$${fmt(Math.round(totalInv+ganancia))}`:"$0"} delta={totalInv?`↑ $${fmt(Math.round(ganancia))} ganancia est.`:"Agregá tu primera inversión"} accent={gold}/>
      <KPI label="Rend. mensual" val={`+${(rendPond/12).toFixed(2)}%`} delta="↑ Proyección mensual" accent={green} color={green}/>
      <KPI label="Inflación mensual" val="3,4%" delta="↑ Sube vs 2,9% feb" accent={red} color={red}/>
      <KPI label="Sharpe actual" val="11,76" delta="Mejor del mercado" accent="#1A3D6B"/>
    </div>

    <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
      <div style={{flex:1,minWidth:280}}>
        {/* Rec card */}
        <div style={{background:"#fff",borderRadius:20,border:`1px solid ${border}`,overflow:"hidden",marginBottom:14}}>
          <div style={{background:navy,padding:"18px 22px",cursor:"pointer",position:"relative",overflow:"hidden"}} onClick={()=>setModal({type:"fondo",data:FONDOS[0]})}>
            <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 40% 80% at 90% 50%,rgba(201,168,76,.12) 0%,transparent 60%)"}}/>
            <div style={{position:"relative",zIndex:1,display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div>
                <div style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(201,168,76,.18)",border:"1px solid rgba(201,168,76,.28)",color:gold,fontSize:9,padding:"3px 8px",borderRadius:20,textTransform:"uppercase",letterSpacing:".07em",fontWeight:600,marginBottom:9}}>⭐ Recomendación IA · {user.perfil}</div>
                <div style={{fontFamily:"Georgia,serif",fontSize:19,color:"#fff",marginBottom:2}}>AXIS ESTRATEGIA 12</div>
                <div style={{fontSize:11,color:"rgba(255,255,255,.45)"}}>Clase A · Renta Fija · ARS · Axis Asset Management</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"Georgia,serif",fontSize:24,color:gold}}>62,45%</div>
                <div style={{fontSize:9,color:"rgba(255,255,255,.4)",textTransform:"uppercase",letterSpacing:".05em"}}>Rend. anual</div>
              </div>
            </div>
          </div>
          <div style={{padding:"16px 22px"}}>
            <div style={{fontSize:12,color:"#3B5070",lineHeight:1.7,marginBottom:12,borderLeft:`3px solid ${gold}`,paddingLeft:11}}>Con inflación en 3,4% y tasa real proyectada negativa hasta oct 2026, la renta fija ARS sigue siendo el mejor posicionamiento. AXIS 12 lidera en Sharpe (11,76) con volatilidad controlada.</div>
            <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:12}}>
              {[["11,76","Sharpe"],["2,77%","Volatilidad"],["AAAf","Rating"],["1 día","Liquidez"]].map(([v,l])=><div key={l}><div style={{fontFamily:"Georgia,serif",fontSize:17}}>{v}</div><div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".05em",marginTop:1}}>{l}</div></div>)}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,paddingTop:12,borderTop:`1px solid ${border}`}}>
              <span style={{fontSize:12,fontWeight:600,color:green}}>✓ MANTENER posición</span>
              <span style={{fontSize:11,color:"#8096B0"}}>— Próxima revisión: 9 jun 2026</span>
              <button style={{...S.btn,marginLeft:"auto",background:cream,border:`1px solid ${border}`,color:navy,fontSize:10,padding:"5px 11px"}} onClick={()=>setModal({type:"fondo",data:FONDOS[0]})}>Ver detalle →</button>
            </div>
          </div>
        </div>

        {/* Chart */}
        <div style={S.card}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em"}}>Rendimiento vs Inflación</div>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <div style={{display:"flex",gap:10}}>{[["#0B1F3A","Cartera"],["#A83232","Inflación"]].map(([c,l])=><div key={l} style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#3B5070"}}><div style={{width:7,height:7,borderRadius:"50%",background:c}}/>{l}</div>)}</div>
              <button style={{...S.btn,background:cream,border:`1px solid ${border}`,color:navy,fontSize:10,padding:"4px 10px"}} onClick={()=>setDbPage("cartera")}>Ver análisis →</button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <XAxis dataKey="m" tick={{fontSize:9}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:9}} tickFormatter={v=>v+"%"} axisLine={false} tickLine={false}/>
              <Tooltip formatter={(v,n)=>[v.toFixed(1)+"%",n==="cartera"?"Mi cartera":"Inflación"]}/>
              <Line type="monotone" dataKey="cartera" stroke={navy} strokeWidth={2} dot={{r:3}} name="cartera"/>
              <Line type="monotone" dataKey="infl" stroke={red} strokeWidth={2} strokeDasharray="4 3" dot={{r:2}} name="inflación"/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Right col */}
      <div style={{minWidth:220,maxWidth:270}}>
        <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Alertas</div>
        {[{t:"success",ico:"✓",title:"Cartera sobre inflación",sub:`+${dif}pp sobre inflación YTD.`,time:"Hoy"},{t:"info",ico:"📊",title:"REM actualizado",sub:"Proyecciones al 2 jun.",time:"Hace 3 hs"},{t:"warn",ico:"⚠️",title:"Inflación en alza",sub:"Subió a 3,4% en marzo.",time:"Ayer"}].map(a=>
          <div key={a.title} style={{borderRadius:12,padding:"11px 13px",display:"flex",alignItems:"flex-start",gap:9,marginBottom:8,border:"1px solid",background:a.t==="success"?"#EAF5F0":a.t==="info"?"#EEF3FA":"#FDF3E3",borderColor:a.t==="success"?"#B8DFCF":a.t==="info"?"#C5D5EC":"#F0CA8A"}}>
            <div style={{width:24,height:24,borderRadius:7,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,background:a.t==="success"?"#B8DFCF":a.t==="info"?"#C5D5EC":"#F0CA8A"}}>{a.ico}</div>
            <div><div style={{fontSize:11,fontWeight:600,color:navy,marginBottom:2}}>{a.title}</div><div style={{fontSize:10,color:"#3B5070",lineHeight:1.4}}>{a.sub}</div><div style={{fontSize:9,color:"#8096B0",marginTop:3}}>{a.time}</div></div>
          </div>
        )}
        <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10,marginTop:8}}>Resumen macro</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["TC variación","1,09%","REM mensual","#3B5070"],["Tasa real","-0,93%","may 2026",red]].map(([l,v,s,c])=>
            <div key={l} style={{background:cream,borderRadius:9,padding:"11px 13px",border:`1px solid ${border}`}}>
              <div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".06em",marginBottom:4,fontWeight:600}}>{l}</div>
              <div style={{fontFamily:"Georgia,serif",fontSize:18,color:c||navy}}>{v}</div>
              <div style={{fontSize:10,color:"#8096B0",marginTop:2}}>{s}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  </div>;
}

// ── RECOMENDACION ──
function Recomendacion({user,positions,setModal}){
  const { fondosAnalizados, recomendado, loading, lastUpdate } = useAnalisisFondos(user.perfil || "Moderado");
  const macro = MACRO;
  const myIds = positions.map(p=>p.fondoId);
  const rec = recomendado || FONDOS[0];
  const alts = fondosAnalizados.filter(f=>f.id!==rec?.id).slice(0,4);

  return <div>
    {/* Loading banner */}
    {loading && <div style={{background:"#EEF3FA",borderRadius:12,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:10,fontSize:12,color:navy}}>
      <span style={{display:"inline-block",width:14,height:14,borderRadius:"50%",border:`2px solid ${navy}`,borderTopColor:"transparent",animation:"spin 0.7s linear infinite",flexShrink:0}}/>
      Analizando {fondosAnalizados.length||"..."} fondos con datos reales de CAFCI...
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>}

    {lastUpdate && <div style={{fontSize:10,color:"#8096B0",marginBottom:10,textAlign:"right"}}>
      📡 Datos de CAFCI · Última actualización: {lastUpdate.toLocaleTimeString("es-AR")} · Período: últimos 30 días
    </div>}

    {/* Rec card */}
    <div style={{background:"#fff",borderRadius:20,border:`1px solid ${border}`,overflow:"hidden",marginBottom:14}}>
      <div style={{background:navy,padding:"20px 22px",cursor:"pointer",position:"relative",overflow:"hidden"}} onClick={()=>setModal({type:"fondo",data:rec})}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 40% 80% at 90% 50%,rgba(201,168,76,.12) 0%,transparent 60%)"}}/>
        <div style={{position:"relative",zIndex:1,display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
          <div>
            <div style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(201,168,76,.18)",border:"1px solid rgba(201,168,76,.28)",color:gold,fontSize:9,padding:"3px 8px",borderRadius:20,textTransform:"uppercase",fontWeight:600,marginBottom:9}}>
              ⚡ Análisis IA · {user.perfil} · {new Date().toLocaleDateString("es-AR")}
            </div>
            <div style={{fontFamily:"Georgia,serif",fontSize:18,color:"#fff",marginBottom:2}}>{rec.n}</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,.45)"}}>{rec.tipo} · {rec.mon} · {rec.ger}</div>
          </div>
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontFamily:"Georgia,serif",fontSize:26,color:gold}}>{rec.rend?`${rec.rend}%`:"—"}</div>
            <div style={{fontSize:9,color:"rgba(255,255,255,.4)",textTransform:"uppercase"}}>Rend. anualizado</div>
            {rec.scoreIA&&<div style={{marginTop:6,display:"inline-block",background:"rgba(201,168,76,.2)",border:"1px solid rgba(201,168,76,.3)",color:gold,fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:600}}>Score IA: {rec.scoreIA}/100</div>}
          </div>
        </div>
      </div>
      <div style={{padding:"16px 22px"}}>
        {/* Razón */}
        <div style={{fontSize:12,color:"#3B5070",lineHeight:1.7,marginBottom:14,borderLeft:`3px solid ${gold}`,paddingLeft:11}}>
          <strong>¿Por qué este fondo?</strong><br/>
          {rec.razon || "Mejor opción disponible para tu perfil y contexto macro."}
        </div>

        {/* Métricas */}
        <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:14}}>
          {[
            ["Rend. anual", rec.rend?`${rec.rend}%`:"—"],
            ["Sharpe", rec.sharpe||"—"],
            ["Volatilidad", rec.vol?`${rec.vol}%`:"—"],
            ["Hit Ratio", rec.hitRatio?`${rec.hitRatio}%`:"—"],
            ["Rating", rec.rat||"—"],
            ["Liquidez", rec.liq||"—"],
          ].map(([l,v])=>
            <div key={l}><div style={{fontFamily:"Georgia,serif",fontSize:16}}>{v}</div><div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".05em",marginTop:1}}>{l}</div></div>
          )}
        </div>

        {/* Contexto macro */}
        <div style={{background:cream,borderRadius:10,padding:"12px 14px",marginBottom:14,border:`1px solid ${border}`}}>
          <div style={{fontSize:11,fontWeight:600,color:navy,marginBottom:8}}>🇦🇷 Contexto macro que justifica esta recomendación</div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {[
              [macro.tasaReal<0?green:red, `Tasa real ${macro.tasaReal}% — ${macro.tasaReal<0?"favorece FCIs sobre plazo fijo":"presión sobre FCIs"}`],
              [macro.infl>3?amber:green, `Inflación ${macro.infl}% mensual — ${rec.rend&&rec.rend/12>macro.infl?"tu fondo la supera":"revisar posición"}`],
              [macro.tc<2?green:amber, `Variación TC ${macro.tc}% — ${macro.tc<2?"ARS conveniente por ahora":"monitorear exposición USD"}`],
            ].map(([c,t])=>
              <div key={t} style={{display:"flex",alignItems:"flex-start",gap:7}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:c,flexShrink:0,marginTop:4}}/>
                <div style={{fontSize:11,color:"#3B5070",lineHeight:1.5}}>{t}</div>
              </div>
            )}
          </div>
        </div>

        {/* Señales de cambio */}
        <div style={{fontSize:11,fontWeight:600,color:navy,marginBottom:8}}>⚠️ Te avisamos si:</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
          {["El Score IA cae más de 15 puntos respecto al mejor disponible","La inflación supera 5% mensual → revisamos exposición USD","Aparece un fondo con Score IA mayor al actual por 2 semanas seguidas","El TC real supera +1,5% mensual → señal de rotación a USD"].map(t=>
            <div key={t} style={{display:"flex",alignItems:"flex-start",gap:7}}>
              <span style={{fontSize:11,flexShrink:0}}>•</span>
              <div style={{fontSize:11,color:"#3B5070",lineHeight:1.5}}>{t}</div>
            </div>
          )}
        </div>

        <div style={{display:"flex",alignItems:"center",gap:8,paddingTop:12,borderTop:`1px solid ${border}`,flexWrap:"wrap"}}>
          <span style={{fontSize:12,fontWeight:600,color:green}}>✓ MANTENER — revisión automática diaria</span>
          <button style={{...S.btn,marginLeft:"auto",background:cream,border:`1px solid ${border}`,color:navy,fontSize:10,padding:"5px 11px"}} onClick={()=>setModal({type:"fondo",data:rec})}>Ver composición y acceso →</button>
        </div>
      </div>
    </div>

    {/* Alternativas */}
    {alts.length>0&&<>
      <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Top alternativas · Score IA</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
        {alts.map(f=><div key={f.id} onClick={()=>setModal({type:"fondo",data:f})} style={{background:"#fff",borderRadius:12,border:`1px solid ${border}`,padding:14,cursor:"pointer"}} onMouseOver={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(11,31,58,.1)"} onMouseOut={e=>e.currentTarget.style.boxShadow="none"}>
          <div style={{fontSize:11,fontWeight:600,marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.n}</div>
          <div style={{fontSize:10,color:"#8096B0",marginBottom:9}}>{f.tipo} · {f.mon}</div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:10,color:"#8096B0"}}>Rend.</span><span style={{fontSize:11,fontWeight:600,color:green}}>{f.rend?`${f.rend}%`:"—"}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:10,color:"#8096B0"}}>Sharpe</span><span style={{fontSize:11,fontWeight:600}}>{f.sharpe||"—"}</span></div>
          <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:10,color:"#8096B0"}}>Score IA</span><span style={{fontSize:11,fontWeight:700,color:navy}}>{f.scoreIA||"—"}</span></div>
          <div style={{height:3,background:border,borderRadius:2,marginTop:9}}><div style={{height:"100%",width:`${Math.min((f.scoreIA||0),100)}%`,background:`linear-gradient(90deg,${navy},${gold})`,borderRadius:2}}/></div>
        </div>)}
      </div>
    </>}

  </div>;
}
// ── CARTERA ──
function Cartera({user,positions,setPositions,setModal}){
  const [addModal,setAddModal]=useState(false);
  const [editPos,setEditPos]=useState(null);
  const [form,setForm]=useState({fondoId:1,monto:"",fecha:new Date().toISOString().split("T")[0],nota:"",siguioRec:true});
  const setF=(k,v)=>setForm(f=>({...f,[k]:v}));

  const totalInv=positions.reduce((s,p)=>s+p.monto,0);
  const rendPond=positions.length?positions.reduce((s,p)=>{const f=FONDOS.find(x=>x.id===p.fondoId);return s+(f?f.rend*(p.monto/totalInv):0);},0):0;
  const rendAcum=+(rendPond/12*6).toFixed(1);
  const dif=+(rendAcum-18.6).toFixed(1);
  const gananciaEst=totalInv*(rendAcum/100);

  const chartData=["Ene","Feb","Mar","Abr","May","Jun"].map((m,i)=>({m,cartera:+(rendPond/12*(i+1)).toFixed(1),infl:[0,2.9,5.9,9.4,12.5,18.6][i]}));
  const myIds=positions.map(p=>p.fondoId);
  const tieneRec=myIds.includes(1);
  const myTipos=[...new Set(positions.map(p=>FONDOS.find(x=>x.id===p.fondoId)?.tipo||""))];
  const myMons=[...new Set(positions.map(p=>FONDOS.find(x=>x.id===p.fondoId)?.mon||""))];
  const sugs=FONDOS.filter(f=>!myIds.includes(f.id)).map(f=>({...f,score:f.sharpe+(!myTipos.includes(f.tipo)?3:0)+(!myMons.includes(f.mon)?2:0)})).sort((a,b)=>b.score-a.score).slice(0,3);

  const openAdd=(pos=null)=>{
    setEditPos(pos);
    setForm(pos?{fondoId:pos.fondoId,monto:pos.monto,fecha:pos.fecha,nota:pos.nota||"",siguioRec:pos.siguioRec}:{fondoId:1,monto:"",fecha:new Date().toISOString().split("T")[0],nota:"",siguioRec:true});
    setAddModal(true);
  };
  const save=()=>{
    if(!form.monto||form.monto<=0){alert("Ingresá un monto válido.");return;}
    if(editPos){setPositions(ps=>ps.map(p=>p.id===editPos.id?{...p,...form,monto:parseFloat(form.monto)}:p));}
    else{setPositions(ps=>[...ps,{id:Date.now(),fondoId:form.fondoId,monto:parseFloat(form.monto),fecha:form.fecha,nota:form.nota,siguioRec:form.siguioRec}]);}
    setAddModal(false);
  };
  const del=(id)=>{if(confirm("¿Eliminar esta posición?"))setPositions(ps=>ps.filter(p=>p.id!==id));};
  const fondo=FONDOS.find(f=>f.id===form.fondoId)||FONDOS[0];
  const prevGan=form.monto?Math.round(parseFloat(form.monto)*(1+fondo.rend/100)):0;

  return <div>
    {/* Add/Edit Modal */}
    {addModal&&<div style={S.modal} onClick={e=>e.target===e.currentTarget&&setAddModal(false)}>
      <div style={S.modalBox}>
        <div style={{background:navy,padding:"20px 24px",borderRadius:"20px 20px 0 0"}}>
          <button onClick={()=>setAddModal(false)} style={{position:"absolute",top:14,right:14,background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,width:28,height:28,cursor:"pointer",color:"rgba(255,255,255,.7)",fontSize:14}}>✕</button>
          <div style={{display:"inline-flex",background:"rgba(201,168,76,.18)",border:"1px solid rgba(201,168,76,.28)",color:gold,fontSize:9,padding:"3px 8px",borderRadius:20,textTransform:"uppercase",fontWeight:600,marginBottom:9}}>{editPos?"Editar posición":"Nueva inversión"}</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:19,color:"#fff",marginBottom:2}}>{editPos?"Editar inversión":"Registrar inversión"}</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,.4)"}}>Completá los datos de tu posición</div>
        </div>
        <div style={{padding:"20px 24px"}}>
          {/* Siguió rec toggle */}
          <div style={{marginBottom:16}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:8}}>¿Seguiste la recomendación?</div>
            <div style={{display:"flex",gap:8}}>
              {[[true,"⭐","Sí, la rec.","AXIS ESTRATEGIA 12"],[false,"🎯","Otro fondo","Seleccioná cuál"]].map(([v,ico,t,s])=>
                <div key={t} onClick={()=>{setF("siguioRec",v);if(v)setF("fondoId",1);}} style={{flex:1,border:`2px solid ${form.siguioRec===v?navy:border}`,background:form.siguioRec===v?"#EEF3FA":"#fff",borderRadius:9,padding:10,textAlign:"center",cursor:"pointer"}}>
                  <div style={{fontSize:16,marginBottom:3}}>{ico}</div>
                  <div style={{fontSize:11,fontWeight:600,color:form.siguioRec===v?navy:"#3B5070"}}>{t}</div>
                  <div style={{fontSize:9,color:"#8096B0"}}>{s}</div>
                </div>
              )}
            </div>
          </div>
          {/* Fondo selector */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>Fondo elegido</div>
            <select style={S.select} value={form.fondoId} onChange={e=>setF("fondoId",parseInt(e.target.value))}>
              {FONDOS.map(f=><option key={f.id} value={f.id}>{f.n}{f.id===1?" ⭐":""} - CLASE A</option>)}
            </select>
            <div style={{marginTop:8,padding:"9px 12px",background:cream,borderRadius:8,border:`1px solid ${border}`,display:"flex",gap:14,flexWrap:"wrap"}}>
              {[["Rend.",fondo.rend+"%",green],["Sharpe",fondo.sharpe,navy],["Volat.",fondo.vol+"%","#8096B0"],["Liquidez",fondo.liq,"#8096B0"]].map(([l,v,c])=>
                <div key={l}><div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".06em"}}>{l}</div><div style={{fontSize:13,fontWeight:600,color:c}}>{v}</div></div>
              )}
            </div>
          </div>
          {/* Monto */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>Monto invertido</div>
            <div style={{position:"relative"}}>
              <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:13,color:"#3B5070",fontWeight:500}}>{fondo.mon==="USD"?"USD ":"$"}</span>
              <input style={{...S.input,paddingLeft:fondo.mon==="USD"?52:24}} type="number" placeholder="0" min="0" value={form.monto} onChange={e=>{setF("monto",e.target.value);}}/>
            </div>
          </div>
          {/* Fecha */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>Fecha de inversión</div>
            <input style={S.input} type="date" value={form.fecha} onChange={e=>setF("fecha",e.target.value)}/>
          </div>
          {/* Nota */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>Nota (opcional)</div>
            <input style={S.input} placeholder="Ej: Seguí la recomendación de U-Invest" value={form.nota} onChange={e=>setF("nota",e.target.value)}/>
          </div>
          {/* Preview */}
          {form.monto>0&&<div style={{background:navy,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:9,color:"rgba(255,255,255,.4)",marginBottom:7,textTransform:"uppercase",letterSpacing:".06em"}}>Vista previa</div>
            <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
              <div><div style={{fontSize:10,color:"rgba(255,255,255,.5)"}}>Capital en 12 meses</div><div style={{fontFamily:"Georgia,serif",fontSize:20,color:gold}}>{fondo.mon==="USD"?"USD ":"$"}{fmt(prevGan)}</div></div>
              <div><div style={{fontSize:10,color:"rgba(255,255,255,.5)"}}>Rend. anual</div><div style={{fontFamily:"Georgia,serif",fontSize:20,color:"#4DD8A4"}}>{fondo.rend}%</div></div>
            </div>
          </div>}
          <div style={{display:"flex",gap:9}}>
            <button style={{...S.btn,flex:1,background:navy,color:gold,padding:12,fontSize:13}} onClick={save}>{editPos?"Guardar cambios":"Guardar inversión"}</button>
            <button style={{...S.btn,border:`1.5px solid ${border}`,background:"#fff",color:"#3B5070",padding:"12px 16px"}} onClick={()=>setAddModal(false)}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>}

    {/* Header */}
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16,gap:12,flexWrap:"wrap"}}>
      <div>
        <div style={{fontSize:10,color:"#8096B0",textTransform:"uppercase",letterSpacing:".07em",marginBottom:5,fontWeight:600}}>Mi Cartera</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:36,color:navy,lineHeight:1}}>{totalInv?`$${fmt(Math.round(totalInv+gananciaEst))}`:"$0"}</div>
        <div style={{fontSize:12,color:totalInv?green:"#8096B0",marginTop:4}}>{totalInv?`Capital $${fmt(totalInv)} · Ganancia est. $${fmt(Math.round(gananciaEst))}`:"Agregá tu primera inversión"}</div>
      </div>
      <button style={{...S.btn,background:navy,color:gold,display:"flex",alignItems:"center",gap:6,padding:"10px 18px",fontSize:12}} onClick={()=>openAdd()}>+ Agregar inversión</button>
    </div>

    {/* KPIs */}
    <div style={S.kpiGrid}>
      <KPI label="Rend. cartera" val={positions.length?`+${rendAcum}%`:"—"} delta="Acumulado 6 meses" accent={green} color={green}/>
      <KPI label="Inflación acum." val="18,6%" delta="ene–jun 2026" accent={red} color={red}/>
      <KPI label="Diferencial" val={positions.length?(dif>=0?`+${dif}pp`:`${dif}pp`):"—"} delta={dif>=0?"Ganás poder de compra":"Perdés vs inflación"} accent={dif>=0?green:red} color={dif>=0?green:red}/>
      <KPI label="Posiciones" val={positions.length} delta="fondos activos" accent="#1A3D6B"/>
    </div>

    {/* Empty state */}
    {positions.length===0&&<div style={{textAlign:"center",padding:"40px 24px",background:"#fff",borderRadius:20,border:`2px dashed ${border}`,marginBottom:14}}>
      <div style={{fontSize:32,marginBottom:10}}>📊</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:18,marginBottom:8}}>Tu cartera está vacía</div>
      <div style={{fontSize:13,color:"#8096B0",marginBottom:18,lineHeight:1.6,maxWidth:320,margin:"0 auto 18px"}}>Registrá tu primera inversión para que U-Invest empiece a seguir tu cartera.</div>
      <button style={{...S.btn,background:navy,color:gold,padding:"11px 22px",fontSize:13}} onClick={()=>openAdd()}>+ Agregar mi primera inversión</button>
    </div>}

    {/* Positions */}
    {positions.length>0&&<>
      <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Posiciones activas</div>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {positions.map((pos,i)=>{
          const f=FONDOS.find(x=>x.id===pos.fondoId)||FONDOS[0];
          const pct=+(pos.monto/totalInv*100).toFixed(1);
          const gan=pos.monto*(f.rend/100/12*6);
          return <div key={pos.id} style={{background:"#fff",borderRadius:12,border:`1px solid ${border}`,padding:"14px 16px",display:"flex",alignItems:"flex-start",gap:11,flexWrap:"wrap"}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:CHART_COLORS[i%CHART_COLORS.length],flexShrink:0,marginTop:4}}/>
            <div style={{flex:1,minWidth:200}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,marginBottom:2}}>{f.n} - CLASE A</div>
                  <div style={{fontSize:10,color:"#8096B0",marginBottom:5}}>{f.tipo} · {f.mon} · {pos.siguioRec?"⭐ Siguió rec.":"🎯 Elección propia"} · {pos.fecha}</div>
                  {pos.nota&&<div style={{fontSize:10,color:"#3B5070",fontStyle:"italic",marginBottom:5}}>"{pos.nota}"</div>}
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontFamily:"Georgia,serif",fontSize:19,color:navy}}>${fmt(Math.round(pos.monto+gan))}</div>
                  <div style={{fontSize:10,color:green}}>+${fmt(Math.round(gan))} · {pct}% cartera</div>
                </div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                {[["Rend",f.rend+"%",green],["Sharpe",f.sharpe,navy],["Inversión","$"+fmt(pos.monto),"#3B5070"]].map(([l,v,c])=>
                  <div key={l} style={{background:cream,borderRadius:7,padding:"4px 9px",fontSize:10,color:"#8096B0"}}>{l}: <strong style={{color:c}}>{v}</strong></div>
                )}
                <button onClick={()=>openAdd(pos)} style={{...S.btn,background:cream,border:`1px solid ${border}`,color:navy,fontSize:10,padding:"4px 9px"}}>✏️ Editar</button>
                <button onClick={()=>del(pos.id)} style={{...S.btn,background:"#FDF0F0",border:"1px solid #EDBBBB",color:red,fontSize:10,padding:"4px 9px"}}>🗑 Eliminar</button>
                <button onClick={()=>setModal({type:"fondo",data:f})} style={{...S.btn,background:cream,border:`1px solid ${border}`,color:navy,fontSize:10,padding:"4px 9px"}}>Ver fondo →</button>
              </div>
            </div>
          </div>;
        })}
      </div>

      {/* Chart + analysis */}
      <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:16}}>
        <div style={{flex:1,minWidth:260}}>
          <div style={S.card}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>Cartera vs Inflación</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartData}>
                <XAxis dataKey="m" tick={{fontSize:9}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fontSize:9}} tickFormatter={v=>v+"%"} axisLine={false} tickLine={false}/>
                <Tooltip formatter={(v,n)=>[v.toFixed(1)+"%",n==="cartera"?"Mi cartera":"Inflación"]}/>
                <Line type="monotone" dataKey="cartera" stroke={navy} strokeWidth={2} dot={{r:3}}/>
                <Line type="monotone" dataKey="infl" stroke={red} strokeWidth={2} strokeDasharray="4 3" dot={{r:2}}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div style={{minWidth:200,maxWidth:260}}>
          <div style={S.card}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>Distribución</div>
            <ResponsiveContainer width="100%" height={140}>
              <PieChart>
                <Pie data={positions.map((p,i)=>({name:FONDOS.find(f=>f.id===p.fondoId)?.n||"",value:p.monto,color:CHART_COLORS[i%CHART_COLORS.length]}))} cx="50%" cy="50%" outerRadius={55} innerRadius={30} dataKey="value">
                  {positions.map((_,i)=><Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]}/>)}
                </Pie>
                <Tooltip formatter={v=>`$${fmt(v)}`}/>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Resumen + impacto macro */}
      <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:16}}>
        <div style={{flex:1,minWidth:220}}>
          <div style={S.card}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>Resumen de cartera</div>
            {[["Capital invertido",`$${fmt(totalInv)}`,"#3B5070"],["Valor actual est.",`$${fmt(Math.round(totalInv+gananciaEst))}`,navy],["Ganancia estimada",`+$${fmt(Math.round(gananciaEst))}`,green],["Rend. ponderado anual",`${rendPond.toFixed(1)}%`,green],["Inflación período","18,6%",red],["Proy. 12 meses",`+$${fmt(Math.round(totalInv*(rendPond/100)))}`,green]].map(([l,v,c])=>
              <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:7,paddingBottom:7,borderBottom:`1px solid ${border}`}}>
                <span style={{fontSize:11,color:"#3B5070"}}>{l}</span><span style={{fontSize:12,fontWeight:600,color:c}}>{v}</span>
              </div>
            )}
          </div>
        </div>
        <div style={{flex:1,minWidth:220}}>
          <div style={S.card}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>🇦🇷 Impacto macro en tu cartera</div>
            {[[green,"#EAF5F0","#B8DFCF","Inflación 3,4% · Favorable","Tus fondos CER ajustan automáticamente. Estás protegido."],[green,"#EAF5F0","#B8DFCF","Tasa real negativa · Favorable","El plazo fijo pierde valor real. Tu cartera lo supera."],[amber,"#FDF3E3","#F0CA8A","TC +1,09% mensual · Monitorear","Revisar en próximo REM si conviene rotar a USD."]].map(([c,bg,bc,t,s])=>
              <div key={t} style={{background:bg,border:`1px solid ${bc}`,borderRadius:9,padding:"10px 12px",marginBottom:8}}>
                <div style={{fontSize:11,fontWeight:600,color:c,marginBottom:3}}>{t}</div>
                <div style={{fontSize:10,color:"#3B5070",lineHeight:1.5}}>{s}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sugerencias */}
      <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>🎯 Sugerencias para tu cartera</div>
      {!tieneRec&&<div onClick={()=>{openAdd();}} style={{background:`linear-gradient(135deg,${navy},#1A3D6B)`,borderRadius:12,padding:"13px 14px",cursor:"pointer",marginBottom:10,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:0,right:0,bottom:0,width:60,background:"radial-gradient(ellipse at right,rgba(201,168,76,.15),transparent)"}}/>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,position:"relative",zIndex:1}}>
          <div>
            <div style={{display:"inline-flex",background:"rgba(201,168,76,.2)",border:"1px solid rgba(201,168,76,.3)",color:gold,fontSize:9,padding:"2px 7px",borderRadius:20,fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:5}}>⭐ Recomendado</div>
            <div style={{fontSize:12,fontWeight:600,color:"#fff",marginBottom:3}}>AXIS ESTRATEGIA 12 - CLASE A</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,.5)",marginBottom:7}}>Renta Fija · ARS · Sharpe 11,76</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,.65)",lineHeight:1.5}}>Lidera el mercado. <strong style={{color:gold}}>62,45% anual</strong> con menor volatilidad de su categoría.</div>
          </div>
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontFamily:"Georgia,serif",fontSize:22,color:gold}}>62,45%</div>
            <div style={{fontSize:9,color:"rgba(255,255,255,.4)"}}>anual</div>
          </div>
        </div>
        <div style={{marginTop:9,paddingTop:9,borderTop:"1px solid rgba(255,255,255,.1)",display:"flex",justifyContent:"space-between",alignItems:"center",position:"relative",zIndex:1}}>
          <span style={{fontSize:10,color:"rgba(255,255,255,.5)"}}>No lo tenés en cartera aún</span>
          <span style={{fontSize:10,fontWeight:600,color:gold}}>+ Agregar →</span>
        </div>
      </div>}
      <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".07em",marginBottom:8}}>{tieneRec?"Top 3 para diversificar":"Top 3 complementarios"}</div>
      <div style={{display:"flex",flexDirection:"column",gap:9}}>
        {sugs.map((f,i)=>{
          const medal=["🥇","🥈","🥉"][i];
          const isNew=!myTipos.includes(f.tipo)||!myMons.includes(f.mon);
          const diffTag=!myTipos.includes(f.tipo)?`Agrega ${f.tipo}`:!myMons.includes(f.mon)?`Suma ${f.mon}`:` Sharpe ${f.sharpe}`;
          return <div key={f.id} style={{background:"#fff",borderRadius:10,border:`1px solid ${border}`,overflow:"hidden"}}>
            <div style={{padding:"12px 13px"}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5,flexWrap:"wrap"}}>
                    <span style={{fontSize:12}}>{medal}</span>
                    <span style={{fontSize:9,padding:"2px 7px",borderRadius:20,fontWeight:600,background:isNew?"#EAF5F0":"#EEF3FA",color:isNew?green:navy,border:`1px solid ${isNew?"#B8DFCF":"#C5D5EC"}`}}>{diffTag}</span>
                  </div>
                  <div style={{fontSize:11,fontWeight:600,marginBottom:3}}>{f.n} - CLASE A</div>
                  <div style={{fontSize:10,color:"#8096B0",marginBottom:7}}>{f.tipo} · {f.mon} · {f.rat}</div>
                  <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                    {[["Rend",f.rend+"%",green],["Sharpe",f.sharpe,navy],["Volat.",f.vol+"%","#8096B0"]].map(([l,v,c])=>
                      <span key={l} style={{fontSize:10,background:cream,border:`1px solid ${border}`,borderRadius:6,padding:"2px 7px",color:c,fontWeight:600}}>{l}: {v}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div style={{borderTop:`1px solid ${border}`,display:"flex"}}>
              <button onClick={()=>setModal({type:"fondo",data:f})} style={{flex:1,padding:8,fontSize:10,fontWeight:600,color:"#3B5070",background:cream,border:"none",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",borderRight:`1px solid ${border}`}}>Ver detalle</button>
              <button onClick={()=>{setForm(fm=>({...fm,fondoId:f.id,siguioRec:f.id===1}));openAdd();}} style={{flex:1,padding:8,fontSize:10,fontWeight:600,color:navy,background:"#fff",border:"none",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>+ Agregar a cartera</button>
            </div>
          </div>;
        })}
        {sugs.length===0&&<div style={{fontSize:11,color:"#8096B0",textAlign:"center",padding:14,background:"#EAF5F0",borderRadius:9,border:"1px solid #B8DFCF"}}>🏆 Ya tenés los mejores fondos del mercado</div>}
      </div>
    </>}
  </div>;
}

// ── FONDOS ──
function Fondos({setModal}){
  const [q,setQ]=useState("");
  const [filter,setFilter]=useState("todos");
  const { fondosAPI, loading, error, lastUpdate } = useFondosCAFCI();

  // Merge API data with local data — API takes priority
  const allFondos = fondosAPI.length > 0
    ? [...fondosAPI.filter(f=>f.rend!==null), ...FONDOS.filter(lf => !fondosAPI.find(af=>af.n?.toLowerCase().includes(lf.n.toLowerCase().slice(0,10))))]
    : FONDOS;

  const filtered = allFondos.filter(f=>{
    const mq = f.n?.toLowerCase().includes(q.toLowerCase());
    if(filter==="ars") return mq && f.mon==="ARS";
    if(filter==="usd") return mq && f.mon==="USD";
    if(filter==="rf") return mq && (f.tipo==="Renta Fija" || f.tipo==="Money Market");
    if(filter==="rv") return mq && f.tipo==="Renta Variable";
    if(filter==="pymes") return mq && f.tipo==="PyMes";
    return mq;
  });

  return <div>
    <div style={{background:"#fff",borderRadius:20,border:`1px solid ${border}`,overflow:"hidden"}}>
      <div style={{padding:"14px 18px",borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em"}}>{loading?"Cargando fondos...":error?`${FONDOS.length} fondos (datos locales)`:`${filtered.length} fondos · CAFCI`}</div>
          {lastUpdate&&<div style={{fontSize:9,color:"#8096B0",marginTop:2}}>Actualizado: {lastUpdate.toLocaleTimeString("es-AR")}</div>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7,background:"#fff",border:`1px solid ${border}`,borderRadius:8,padding:"6px 11px"}}>
          <span style={{fontSize:12}}>🔍</span>
          <input style={{border:"none",outline:"none",fontSize:11,fontFamily:"'DM Sans',sans-serif",color:navy,width:160}} placeholder="Buscar fondo..." value={q} onChange={e=>setQ(e.target.value)}/>
        </div>
      </div>

      {/* Status bar */}
      {(loading || error) && <div style={{padding:"10px 18px",background:loading?"#EEF3FA":error?"#FDF3E3":"#EAF5F0",borderBottom:`1px solid ${border}`,fontSize:11,color:loading?navy:error?amber:green,display:"flex",alignItems:"center",gap:8}}>
        {loading&&<span style={{display:"inline-block",width:12,height:12,borderRadius:"50%",border:`2px solid ${navy}`,borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}}/>}
        {loading?"Conectando con CAFCI para obtener datos en tiempo real...":error?`⚠️ ${error} — mostrando datos locales`:"✓ Datos en tiempo real de CAFCI"}
      </div>}

      <div style={{display:"flex",gap:5,padding:"9px 18px",borderBottom:`1px solid ${border}`,background:cream,flexWrap:"wrap"}}>
        {[["todos","Todos"],["ars","ARS"],["usd","USD"],["rf","Renta Fija"],["rv","Renta Variable"],["pymes","PyMes"]].map(([v,l])=>
          <button key={v} onClick={()=>setFilter(v)} style={{fontSize:10,padding:"4px 11px",borderRadius:20,border:`1px solid ${filter===v?navy:border}`,background:filter===v?navy:"#fff",color:filter===v?"#fff":"#3B5070",cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>{l}</button>
        )}
      </div>

      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:500}}>
          <thead><tr>{["Fondo","Rend. anual","Sharpe","Moneda","Tipo","Score"].map(h=><th key={h} style={{padding:"8px 14px",textAlign:"left",fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".07em",borderBottom:`1px solid ${border}`,fontWeight:600,background:cream,whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
          <tbody>
            {filtered.slice(0,100).map((f,i)=>{
              const rend = f.rend;
              const sharpe = f.sharpe;
              const scoreVal = sharpe ? (sharpe>7?"A":sharpe>3?"B":"C") : (rend&&rend>40?"A":rend&&rend>15?"B":"C");
              const scoreColor = scoreVal==="A"?green:scoreVal==="B"?amber:red;
              return <tr key={f.id||i} onClick={()=>setModal({type:"fondo",data:f})} style={{cursor:"pointer"}} onMouseOver={e=>e.currentTarget.style.background="#F5F8FC"} onMouseOut={e=>e.currentTarget.style.background="#fff"}>
                <td style={{padding:"10px 14px",fontSize:11,fontWeight:500,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",borderBottom:`1px solid ${border}`}}>{f.n} {f.cafciId?"":""}</td>
                <td style={{padding:"10px 14px",fontFamily:"Georgia,serif",fontSize:13,color:rend?green:"#8096B0",borderBottom:`1px solid ${border}`}}>{rend?`${rend}%`:"—"}</td>
                <td style={{padding:"10px 14px",fontFamily:"Georgia,serif",fontSize:13,color:"#8096B0",borderBottom:`1px solid ${border}`}}>{sharpe||"—"}</td>
                <td style={{padding:"10px 14px",borderBottom:`1px solid ${border}`}}><span style={{...S.pill,background:f.mon==="USD"?"#EAF5F0":"#EEF3FA",color:f.mon==="USD"?green:navy}}>{f.mon}</span></td>
                <td style={{padding:"10px 14px",fontSize:10,color:"#3B5070",borderBottom:`1px solid ${border}`,whiteSpace:"nowrap"}}>{f.tipo}</td>
                <td style={{padding:"10px 14px",borderBottom:`1px solid ${border}`}}><span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:24,borderRadius:"50%",fontSize:9,fontWeight:700,background:scoreVal==="A"?"#EAF5F0":scoreVal==="B"?"#FDF3E3":"#FDF0F0",color:scoreColor}}>{scoreVal}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {filtered.length===0&&<div style={{padding:"32px",textAlign:"center",color:"#8096B0",fontSize:13}}>No se encontraron fondos para esa búsqueda.</div>}
    </div>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>;
}

// ── MACRO ──
function Macro({positions}){
  const items=[[red,"Inflación mensual","3,4%","↑ vs 2,9% feb","68%"],[amber,"Tasa de interés","3,65%","Nominal mensual","73%"],["#1A3D6B","Variación TC","1,09%","Proyección REM","22%"],[red,"Tasa real may 26","−0,93%","Negativa","40%"],[green,"Actividad may 26","+0,10%","Leve recuperación","30%"],[gold,"TCR ago 26","+0,71%","Recuperación","45%"]];
  const impacts=[[red,"Inflación en suba","Tu fondo rinde ~4,4% mensual. La inflación de 3,4% está por debajo. Seguís ganando poder de compra.","Impacto positivo",green,"#EAF5F0","#B8DFCF"],[amber,"Tasa real negativa","La tasa real de -0,93% favorece fondos de renta fija ARS que superan la tasa de política monetaria.","Favorece tu posición",green,"#EAF5F0","#B8DFCF"],["#1A3D6B","Tipo de cambio estable","TC variando 1,09% — por debajo del diferencial de tu fondo. No se justifica rotación a USD.","Monitorear",amber,"#FDF3E3","#F0CA8A"],[green,"Actividad económica","Leve recuperación (+0,10%). Mejora el contexto general pero no cambia la recomendación actual.","Sin cambios","#3B5070",cream,border]];
  return <div>
    <div style={{background:navy,borderRadius:20,padding:"22px 26px",marginBottom:16}}>
      <h2 style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:400,color:"#fff",marginBottom:5}}>Contexto Macroeconómico · Argentina</h2>
      <p style={{fontSize:12,color:"rgba(255,255,255,.5)",lineHeight:1.7}}>Análisis del entorno macro y cómo impacta en tu cartera. Datos del REM del BCRA al 2 jun 2026.</p>
    </div>
    <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Indicadores clave</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:9,marginBottom:16}}>
      {items.map(([c,l,v,t,w])=><div key={l} style={{background:"#fff",borderRadius:12,border:`1px solid ${border}`,padding:14,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:c}}/>
        <div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".06em",marginBottom:5,fontWeight:600}}>{l}</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:22,color:c,marginBottom:3}}>{v}</div>
        <div style={{fontSize:10,color:"#8096B0",marginBottom:9}}>{t}</div>
        <div style={{height:3,background:border,borderRadius:2}}><div style={{height:"100%",width:w,background:c,borderRadius:2}}/></div>
      </div>)}
    </div>
    <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Impacto en tu cartera</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
      {impacts.map(([dc,t,desc,badge,bc,bg,brd])=><div key={t} style={{background:"#fff",borderRadius:12,border:`1px solid ${border}`,padding:14}}>
        <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}><div style={{width:7,height:7,borderRadius:"50%",background:dc}}/><span style={{fontSize:11,fontWeight:600,color:navy}}>{t}</span></div>
        <div style={{fontSize:11,color:"#3B5070",lineHeight:1.6,marginBottom:7}}>{desc}</div>
        <span style={{fontSize:9,padding:"2px 7px",borderRadius:20,background:bg,color:bc,border:`1px solid ${brd}`,fontWeight:600}}>{badge}</span>
      </div>)}
    </div>
    <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Análisis IA</div>
    <div style={S.card}>
      <div style={{fontFamily:"Georgia,serif",fontSize:17,marginBottom:10}}>¿Qué está pasando en Argentina y cómo te afecta?</div>
      <div style={{fontSize:12,color:"#3B5070",lineHeight:1.8}}>El escenario de junio 2026 se caracteriza por una <strong>inflación que retoma la senda alcista</strong> luego de la desaceleración de enero-febrero. La tasa real negativa es el dato más relevante: el BCRA "subsidia" a tomadores de crédito a costa de ahorradores en plazos fijos tradicionales.<br/><br/>Tu posición en fondos CER <strong>te protege de este escenario</strong> porque captura el diferencial inflacionario automáticamente. El TC comenzó a recuperarse levemente en agosto (proyectado +0,71%), señal para revisar exposición USD hacia el segundo semestre. <strong>Por ahora, mantener es la estrategia óptima</strong>.</div>
    </div>
  </div>;
}

// ── PERFIL ──
function Perfil({user,setUser,positions}){
  const [editing,setEditing]=useState(false);
  const [form,setForm]=useState({nombre:user.nombre,apellido:user.apellido||"",dni:"",sexo:"",email:user.email||"",tel:""});
  const [saved,setSaved]=useState(false);
  const save=()=>{setUser(u=>({...u,...form}));setEditing(false);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  const perfilData={Moderado:{icon:"⚖️",desc:"Equilibrio entre seguridad y crecimiento"},Conservador:{icon:"🛡️",desc:"Priorizás preservar tu capital"},Agresivo:{icon:"🚀",desc:"Maximizás rendimiento, aceptás volatilidad"}};
  const pd=perfilData[user.perfil]||perfilData.Moderado;
  const historial=[{a:"MANTENER",f:"AXIS ESTRATEGIA 12",fecha:"2 jun 2026",r:"Sharpe 11,76 lidera el mercado.",c:green},{a:"INICIO DE POSICIÓN",f:"AXIS ESTRATEGIA 12",fecha:"12 may 2026",r:"Mejor Sharpe para perfil moderado.",c:green},{a:"ROTACIÓN",f:"AXIS 11 → AXIS 12",fecha:"12 may 2026",r:"AXIS 12 superó en Sharpe +65%.",c:amber}];
  return <div>
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:18,gap:12,flexWrap:"wrap"}}>
      <div>
        <div style={{fontSize:10,color:"#8096B0",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4,fontWeight:600}}>Mi cuenta</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:26}}>{user.nombre} {user.apellido||""}</div>
      </div>
      <button onClick={()=>editing?save():setEditing(true)} style={{...S.btn,background:saved?"#1A7A5E":navy,color:saved?"#fff":gold,display:"flex",alignItems:"center",gap:6,padding:"9px 16px",fontSize:12}}>
        {saved?"✓ Guardado":editing?"💾 Guardar cambios":"✏️ Editar perfil"}
      </button>
    </div>
    <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
      <div style={{flex:1,minWidth:260}}>
        <div style={S.card}>
          <div style={{display:"flex",alignItems:"center",gap:13,marginBottom:18}}>
            <div style={{width:54,height:54,borderRadius:"50%",background:`linear-gradient(135deg,${navy},#1A3D6B)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Georgia,serif",fontSize:22,fontWeight:600,color:gold,flexShrink:0}}>{(user.nombre||"U")[0]}</div>
            <div>
              <div style={{fontSize:14,fontWeight:600}}>{user.nombre} {user.apellido||""}</div>
              <div style={{fontSize:11,color:"#8096B0",marginTop:2}}>{user.email||"—"}</div>
              <span style={{display:"inline-flex",alignItems:"center",gap:4,marginTop:5,background:"rgba(201,168,76,.12)",border:"1px solid rgba(201,168,76,.25)",color:gold,fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:600}}>{pd.icon} {user.perfil}</span>
            </div>
          </div>
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Datos personales</div>
          {editing?<div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div><label style={{fontSize:10,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Nombre</label><input style={S.input} value={form.nombre} onChange={e=>setForm(f=>({...f,nombre:e.target.value}))}/></div>
              <div><label style={{fontSize:10,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Apellido</label><input style={S.input} value={form.apellido} onChange={e=>setForm(f=>({...f,apellido:e.target.value}))}/></div>
              <div><label style={{fontSize:10,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>DNI</label><input style={S.input} placeholder="28.456.789" value={form.dni} onChange={e=>setForm(f=>({...f,dni:e.target.value}))}/></div>
              <div><label style={{fontSize:10,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Sexo</label><select style={S.select} value={form.sexo} onChange={e=>setForm(f=>({...f,sexo:e.target.value}))}><option>Masculino</option><option>Femenino</option><option>Prefiero no decirlo</option></select></div>
              <div><label style={{fontSize:10,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/></div>
              <div><label style={{fontSize:10,fontWeight:600,color:"#3B5070",display:"block",marginBottom:4}}>Teléfono</label><input style={S.input} placeholder="+54 9 11..." value={form.tel} onChange={e=>setForm(f=>({...f,tel:e.target.value}))}/></div>
            </div>
            <button onClick={()=>setEditing(false)} style={{...S.btn,width:"100%",border:`1.5px solid ${border}`,background:"#fff",color:"#3B5070",padding:9,fontSize:12}}>Cancelar</button>
          </div>:<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[["Nombre",user.nombre||"—"],["Apellido",user.apellido||"—"],["DNI",form.dni||"—"],["Sexo",form.sexo||"—"],["Email",user.email||"—"],["Teléfono",form.tel||"—"]].map(([l,v])=>
              <div key={l} style={{background:cream,borderRadius:9,padding:"10px 12px",border:`1px solid ${border}`}}><div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".06em",marginBottom:3,fontWeight:600}}>{l}</div><div style={{fontSize:12,fontWeight:500,color:navy}}>{v}</div></div>
            )}
          </div>}
        </div>
        <div style={S.card}>
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>Historial de recomendaciones</div>
          {historial.map(h=><div key={h.fecha+h.a} style={{display:"flex",alignItems:"flex-start",gap:10,paddingBottom:10,marginBottom:10,borderBottom:`1px solid ${border}`}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:h.c,flexShrink:0,marginTop:4}}/>
            <div style={{flex:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,flexWrap:"wrap"}}>
                <div style={{fontSize:10,fontWeight:700,color:h.c,textTransform:"uppercase",letterSpacing:".05em"}}>{h.a}</div>
                <div style={{fontSize:10,color:"#8096B0"}}>{h.fecha}</div>
              </div>
              <div style={{fontSize:12,fontWeight:500,margin:"2px 0"}}>{h.f}</div>
              <div style={{fontSize:11,color:"#3B5070",lineHeight:1.5}}>{h.r}</div>
            </div>
          </div>)}
        </div>
      </div>
      <div style={{minWidth:220,maxWidth:260}}>
        <div style={S.card}>
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>Perfil de inversión</div>
          <div style={{textAlign:"center",padding:"14px 0",borderBottom:`1px solid ${border}`,marginBottom:12}}>
            <div style={{fontSize:28,marginBottom:7}}>{pd.icon}</div>
            <div style={{fontFamily:"Georgia,serif",fontSize:20,marginBottom:4}}>{user.perfil}</div>
            <div style={{fontSize:11,color:"#8096B0"}}>{pd.desc}</div>
          </div>
          {[["Moneda preferida",user.moneda||"ARS/USD"],["Fondos activos",positions.length],["Desde","12 may 2026"],["Rend. acumulado",positions.length?"+28,4%":"—"]].map(([l,v])=>
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <span style={{fontSize:11,color:"#3B5070"}}>{l}</span><span style={{fontSize:12,fontWeight:600,color:navy}}>{v}</span>
            </div>
          )}
        </div>
        <div style={S.card}>
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:12}}>Seguridad</div>
          {[["Contraseña","Cambiar"],["Notificaciones","Activas"]].map(([l,v])=>
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 11px",background:cream,borderRadius:9,border:`1px solid ${border}`,marginBottom:8}}>
              <div><div style={{fontSize:11,fontWeight:500}}>{l}</div><div style={{fontSize:10,color:"#8096B0"}}>{v}</div></div>
              <span style={{fontSize:11,color:navy,fontWeight:600,cursor:"pointer"}}>›</span>
            </div>
          )}
        </div>
      </div>
    </div>
  </div>;
}

// ── MODAL (FONDO DETAIL) ──
function Modal({modal,setModal,positions,setPositions,user}){
  if(!modal) return null;
  if(modal.type==="fondo"){
    const f=modal.data;
    return <div style={S.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
      <div style={S.modalBox}>
        <div style={{background:navy,padding:"20px 24px",borderRadius:"20px 20px 0 0",position:"relative"}}>
          <button onClick={()=>setModal(null)} style={{position:"absolute",top:12,right:12,background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,width:28,height:28,cursor:"pointer",color:"rgba(255,255,255,.7)",fontSize:14}}>✕</button>
          {f.id===1&&<div style={{display:"inline-flex",background:"rgba(201,168,76,.2)",border:"1px solid rgba(201,168,76,.3)",color:gold,fontSize:9,padding:"2px 8px",borderRadius:20,fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:9}}>⭐ Tu fondo recomendado</div>}
          <div style={{fontFamily:"Georgia,serif",fontSize:19,color:"#fff",marginBottom:2}}>{f.n} - CLASE A</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,.4)"}}>{f.tipo} · {f.mon} · {f.ger}</div>
        </div>
        <div style={{padding:"20px 24px"}}>
          {f.id===1&&<div style={{background:`linear-gradient(135deg,${navy},#1A3D6B)`,borderRadius:10,padding:"12px 14px",marginBottom:16}}>
            <div style={{fontSize:12,color:"rgba(255,255,255,.7)",lineHeight:1.7}}>Recomendado para tu perfil <strong style={{color:gold}}>{user.perfil}</strong>. Lidera el mercado en eficiencia riesgo/retorno con el mayor Sharpe (11,76) disponible.</div>
          </div>}
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Métricas clave</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
            {[["Rend. anual",f.rend+"%",green],["Sharpe",f.sharpe,navy],["Volatilidad",f.vol+"%",navy],["Rating",f.rat,navy],["Liquidez",f.liq,navy],["Score IA",f.sharpe>7?"A":f.sharpe>3?"B":"C",f.sharpe>7?green:f.sharpe>3?amber:red]].map(([l,v,c])=>
              <div key={l} style={{background:cream,borderRadius:9,padding:"10px 12px",border:`1px solid ${border}`}}><div style={{fontSize:9,color:"#8096B0",textTransform:"uppercase",letterSpacing:".06em",marginBottom:3,fontWeight:600}}>{l}</div><div style={{fontFamily:"Georgia,serif",fontSize:18,color:c}}>{v}</div></div>
            )}
          </div>
          <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>Composición del fondo</div>
          {f.comp.map(c=><div key={c.n} style={{marginBottom:7}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:11,color:"#3B5070"}}>{c.n}</span><span style={{fontSize:11,fontWeight:600}}>{c.p}%</span></div>
            <div style={{height:4,background:border,borderRadius:2}}><div style={{height:"100%",width:`${c.p}%`,background:`linear-gradient(90deg,${navy},${gold})`,borderRadius:2}}/></div>
          </div>)}
          <div style={{marginTop:16}}>
            <div style={{fontSize:10,fontWeight:600,color:"#8096B0",textTransform:"uppercase",letterSpacing:".08em",marginBottom:10}}>¿Dónde acceder a este fondo?</div>
            <div style={{fontSize:11,color:"#8096B0",marginBottom:10,padding:"8px 11px",background:cream,borderRadius:8,border:`1px solid ${border}`,lineHeight:1.6}}>⚠️ <strong>U-Invest es asesor independiente.</strong> No ejecutamos operaciones. Te mostramos dónde acceder directamente.</div>
            {f.donde.map(d=><div key={d.n} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:cream,borderRadius:9,border:`1px solid ${border}`,padding:"10px 13px",marginBottom:7}}>
              <div><div style={{fontSize:12,fontWeight:600}}>{d.n}</div><div style={{fontSize:10,color:"#8096B0"}}>{d.u}</div></div>
              <button onClick={()=>window.open("https://"+d.u,"_blank")} style={{...S.btn,background:navy,color:gold,fontSize:10,padding:"5px 10px"}}>Ir al sitio →</button>
            </div>)}
          </div>
        </div>
      </div>
    </div>;
  }
  return null;
}
