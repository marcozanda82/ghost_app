/**
 * SalaComandi.jsx — Porting React da index stabile (HTML).
 * MOTORE BIOCHIMICO (logica pura in useBiochimico.js):
 * - 40+ parametri: TARGETS + computeTotali (amino, vit, min, omega dal DB cibi).
 * - Delta correction: calcolaObiettiviPastoConArray in useMemo (target pasti a cascata).
 * - Firebase: intero albero tracker_data scaricato (get), poi onValue solo per oggi.
 * - Completamento AI: getDefaultNutrientValue ovunque un valore manca; mai 0 né blocco.
 * 
 * FIX CRITICO: Retrocompatibilità mealType - 'spuntino' e 'snack' sono equivalenti
 */
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ComposedChart, Line, XAxis, YAxis, ResponsiveContainer, ReferenceLine, ReferenceDot, CartesianGrid, Area, BarChart, Bar, Tooltip } from 'recharts';

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from 'firebase/auth';
import { getDatabase, ref, get, set, onValue } from 'firebase/database';

import { TARGETS, DEFAULT_TARGETS, useBiochimico, getDefaultNutrientValue, getTargetForNutrient } from './useBiochimico';

const firebaseConfig = {
  apiKey: "AIzaSyA5pSzpfq1aGZ1wjNV5-eXnIqWL6brl424",
  authDomain: "mio-tracker.firebaseapp.com",
  databaseURL: "https://mio-tracker-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "mio-tracker",
  storageBucket: "mio-tracker.firebasestorage.app",
  messagingSenderId: "382993217593",
  appId: "1:382993217593:web:f0780aa061c23f9503f5e8"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getDatabase(app);

const getTodayString = () => new Date().toISOString().split('T')[0];
const getYesterdayString = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; };

// ============================================================================
// UTILITY CRITICHE PER RETROCOMPATIBILITÀ MEALTYPE
// ============================================================================

/** 
 * Gruppi di equivalenza per mealType. Tutti gli ID nello stesso array sono considerati lo stesso pasto.
 * Questo risolve il problema dei dati storici con 'spuntino' vs nuovi 'snack'.
 */
const MEAL_TYPE_GROUPS = {
  colazione: ['merenda1', 'colazione'],
  pranzo: ['pranzo'],
  spuntino: ['merenda2', 'spuntino', 'snack'], // merenda2 = spuntino pomeridiano, snack = generico
  cena: ['cena']
};

/** 
 * Mappa inversa: da qualsiasi ID al gruppo canonico.
 * 'merenda1' → 'colazione', 'spuntino' → 'spuntino', 'snack' → 'spuntino'
 */
const MEAL_TYPE_TO_CANONICAL = {};
Object.entries(MEAL_TYPE_GROUPS).forEach(([canonical, aliases]) => {
  aliases.forEach(alias => {
    MEAL_TYPE_TO_CANONICAL[alias] = canonical;
  });
});

/** 
 * Verifica se due mealType appartengono allo stesso gruppo (sono equivalenti)
 */
function areMealTypesEquivalent(typeA, typeB) {
  if (!typeA || !typeB) return false;
  if (typeA === typeB) return true;
  const canonicalA = MEAL_TYPE_TO_CANONICAL[typeA] || typeA;
  const canonicalB = MEAL_TYPE_TO_CANONICAL[typeB] || typeB;
  return canonicalA === canonicalB;
}

/** 
 * Converte qualsiasi mealType al suo ID canonico per salvataggio nuovi dati
 */
function toCanonicalMealType(type) {
  return MEAL_TYPE_TO_CANONICAL[type] || type;
}

/** 
 * Ottiene tutti gli ID equivalenti per un dato mealType (per filtri OR).
 * Accetta anche id composito "mealType_time" (es. snack_16.5) e usa solo la parte mealType.
 */
function getEquivalentMealTypes(type) {
  const str = String(type ?? '');
  const base = str.includes('_') ? str.slice(0, str.indexOf('_')) : type;
  const canonical = toCanonicalMealType(base);
  return MEAL_TYPE_GROUPS[canonical] || [base];
}

/** 🍝 per Pranzo/Cena, 🍎 per gli altri. */
function getMealIcon(label) {
  const l = (label || '').toString().toLowerCase();
  if (l.includes('pranzo') || l.includes('cena')) return '🍝';
  // Tutti gli snack/merende usano 🍎
  if (l.includes('snack') || l.includes('spuntino') || l.includes('merenda') || l.includes('colazione')) return '🍎';
  return '🍎';
}

function getSlotKey(item) {
  if (item.type !== 'food') return null;
  const canonical = toCanonicalMealType(item.mealType);
  const t = typeof item.mealTime === 'number' && !Number.isNaN(item.mealTime) ? item.mealTime : 12;
  return `${canonical}_${t}`;
}

/** Decimale (es. 12.5) -> "HH:mm" per display. */
function decimalToTimeStr(dec) {
  if (typeof dec !== 'number' || Number.isNaN(dec)) return '12:00';
  const h = Math.max(0, Math.min(23, Math.floor(dec)));
  const m = Math.round((dec - h) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Dati reali + ideali per il cruscotto energetico 0-24h: 25 punti (ore 0..24).
 * timelineNodes: array di { id, type: 'meal'|'work'|'workout', time, duration?, kcal?, icon }.
 * idealStrategy: { colazione, pranzo, spuntino, cena, allenamento } kcal obiettivo.
 * Restituisce { chartData, realTotals } per grafico doppia curva e semafori.
 */
function generateRealEnergyData(timelineNodes, dailyLog, idealStrategy) {
  const log = dailyLog || [];
  const ideal = idealStrategy || {};

  // Mappa da canonical strategy key a array di mealType equivalenti
  const strategyToMealTypes = {
    colazione: ['merenda1', 'colazione'],
    pranzo: ['pranzo'],
    spuntino: ['merenda2', 'spuntino', 'snack'],
    cena: ['cena']
  };

  let workoutKcal = 0;
  const realTotals = { colazione: 0, pranzo: 0, spuntino: 0, cena: 0, allenamento: 0 };
  
  log.forEach(entry => {
    const kcal = Number(entry.kcal ?? entry.cal ?? 0) || 0;
    if (entry.type === 'workout') {
      workoutKcal += kcal;
      return;
    }
    // Trova a quale strategia appartiene questo mealType
    const entryMealType = entry.mealType || 'cena';
    for (const [strategyKey, mealTypes] of Object.entries(strategyToMealTypes)) {
      if (mealTypes.includes(entryMealType)) {
        realTotals[strategyKey] = (realTotals[strategyKey] || 0) + kcal;
        break;
      }
    }
  });
  realTotals.allenamento = workoutKcal;

  let currentEnergy = 70;
  let currentIdealEnergy = 70;
  const out = [];
  for (let h = 0; h <= 24; h++) {
    currentEnergy -= 2;
    currentIdealEnergy -= 2;

    (timelineNodes || []).forEach(node => {
      if (node.type === 'meal' && Math.round(node.time) === h) {
        const realK = realTotals[node.strategyKey] || 0;
        const idealK = Number(ideal[node.strategyKey]) || (node.strategyKey === 'spuntino' ? 250 : 500);
        currentEnergy += realK / 20;
        currentIdealEnergy += idealK / 20;
      }
      if (node.type === 'work' || node.type === 'workout') {
        const startH = Math.round(node.time);
        const dur = Math.max(1, Math.round(node.duration || 1));
        if (h >= startH && h < startH + dur) {
          const burnKcal = node.kcal || 300;
          const drain = (burnKcal / dur) / 10;
          currentEnergy -= drain;
          currentIdealEnergy -= drain;
        }
      }
    });

    currentEnergy = Math.max(0, Math.min(100, currentEnergy));
    currentIdealEnergy = Math.max(0, Math.min(100, currentIdealEnergy));
    out.push({ time: h, energy: currentEnergy, idealEnergy: currentIdealEnergy });
  }
  return { chartData: out, realTotals };
}

/**
 * Struttura tracker_data (da vecchio storico.html e index_vecchio.html):
 * Elenco piatto: chiavi trackerStorico_YYYY-MM-DD, nessun annidamento anno/mese.
 * Ogni valore: { data: string, log: Array, note?: string }.
 */
const TRACKER_STORICO_KEY = (date) => `trackerStorico_${date}`;

/** Mappa descrizione pasto (vecchio formato) -> mealId canonico. */
const DESC_TO_MEAL_ID = {
  colazione: 'merenda1', 'merenda am': 'merenda1', merenda1: 'merenda1',
  pranzo: 'pranzo',
  'merenda pm': 'merenda2', merenda2: 'merenda2', 
  spuntino: 'snack', snack: 'snack', // TUTTI gli snack vanno a 'snack'
  cena: 'cena'
};

function inferMealType(entry) {
  if (entry.mealId) return entry.mealId;
  if (entry.mealType) return entry.mealType;
  const key = (entry.desc || '').toLowerCase().trim();
  return DESC_TO_MEAL_ID[key] || (key ? key.replace(/\s+/g, '_') : null) || 'pranzo';
}

/** Normalizza log da formato vecchio (meal/items, single, workout) a lista piatta. */
function normalizeLogData(rawLog) {
  const out = [];
  (rawLog || []).forEach(entry => {
    if (entry.type === 'meal') {
      const mealType = inferMealType(entry);
      (entry.items || []).forEach(subItem => {
        out.push({
          ...subItem, type: 'food', mealType,
          id: subItem.id || Date.now() + Math.random(),
          kcal: subItem.kcal ?? subItem.cal ?? 0
        });
      });
    } else if (entry.type === 'single' || !entry.type) {
      const mealType = inferMealType(entry);
      out.push({
        ...entry, type: 'food', mealType,
        id: entry.id || Date.now() + Math.random(),
        kcal: entry.kcal ?? entry.cal ?? 0
      });
    } else {
      out.push({ ...entry, kcal: entry.kcal ?? entry.cal ?? 0 });
    }
  });
  return out;
}

/** Ricostruisce la struttura a "cartelle" (meal/items) per Firebase a partire dal dailyLog piatto. */
const MEAL_ORDER_SAVE = ['merenda1', 'pranzo', 'merenda2', 'cena', 'snack'];
const MEAL_LABELS_SAVE = { 
  merenda1: 'Colazione', 
  pranzo: 'Pranzo', 
  merenda2: 'Merenda PM', 
  cena: 'Cena', 
  snack: 'Snack',
  spuntino: 'Snack',
  colazione: 'Colazione'
};

function denormalizeLogForFirebase(flatLog) {
  if (!flatLog || !Array.isArray(flatLog)) return [];
  const meals = {};
  const workouts = [];
  
  (flatLog || []).forEach(entry => {
    if (entry.type === 'workout' || entry.type === 'work') {
      const desc = entry.desc || entry.name || (entry.type === 'work' ? 'Lavoro' : 'Attività');
      const cal = entry.kcal ?? entry.cal ?? 0;
      workouts.push({
        type: 'workout',
        id: entry.id,
        desc,
        name: desc,
        cal,
        kcal: cal,
        duration: entry.duration,
        workoutType: entry.workoutType
      });
      return;
    }
    if (entry.type === 'food' || !entry.type) {
      // Usa il mealType così com'è (può essere 'spuntino' o 'snack')
      const mealType = entry.mealType || 'cena';
      if (!meals[mealType]) meals[mealType] = [];
      const { type, mealType: _, ...rest } = entry;
      meals[mealType].push({ ...rest, kcal: rest.kcal ?? rest.cal ?? 0, cal: rest.cal ?? rest.kcal ?? 0 });
    }
  });
  
  const result = [];
  const order = [...MEAL_ORDER_SAVE];
  const otherMeals = Object.keys(meals).filter(m => !order.includes(m));
  
  [...order, ...otherMeals].forEach(mealId => {
    if (!meals[mealId] || meals[mealId].length === 0) return;
    result.push({
      type: 'meal',
      mealId,
      desc: MEAL_LABELS_SAVE[mealId] || mealId,
      items: meals[mealId].map(it => ({ 
        id: it.id, 
        desc: it.desc || it.name, 
        qta: it.qta ?? it.weight, 
        weight: it.weight ?? it.qta, 
        prot: it.prot, 
        kcal: it.kcal, 
        cal: it.cal, 
        ...it 
      }))
    });
  });
  result.push(...workouts);
  return result;
}

/** Dato l'albero tracker_data scaricato (una tantum), restituisce il log normalizzato per una data. */
function getLogFromStoricoTree(tree, dateStr) {
  if (!tree || !dateStr) return [];
  const node = tree[TRACKER_STORICO_KEY(dateStr)];
  const log = node?.log ?? node?.dati?.log;
  return normalizeLogData(log ?? []);
}

const STRATEGY_PROFILES = {
  upper:  { label: '💪 UPPER', kcal: 2300 },
  gambe:  { label: '🦵 GAMBE', kcal: 2500 },
  riposo: { label: '🧘 RIPOSO', kcal: 2000 }
};

/** Per calcolo Deficit/Surplus nello storico */
const PIANO_SETTIMANALE = {
  0: { cal: 2300, prot: 140 },
  1: { cal: 2300, prot: 140 },
  2: { cal: 2300, prot: 140 },
  3: { cal: 2300, prot: 140 },
  4: { cal: 2300, prot: 140 },
  5: { cal: 2300, prot: 140 },
  6: { cal: 2300, prot: 140 }
};

export default function SalaComandi() {
  // AUTENTICAZIONE
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userUid, setUserUid] = useState(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [isBooting, setIsBooting] = useState(false);

  // STATI INTERFACCIA
  const [currentTime, setCurrentTime] = useState(8);
  const [showDetails, setShowDetails] = useState(false);
  const [chartUnit, setChartUnit] = useState('percent'); // 'percent' | 'kcal'
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [activeAction, setActiveAction] = useState(null); 
  
  const [selectedHistoryDate, setSelectedHistoryDate] = useState('');

  // SOTTO-NAVIGAZIONE DIARIO
  const [diarioTab, setDiarioTab] = useState('storico');
  const [telemetrySubTab, setTelemetrySubTab] = useState('macro');
  const [expandedStoricoDate, setExpandedStoricoDate] = useState(null);

  // STRATEGIA E DATABASE
  const [dayProfile, setDayProfile] = useState('upper');
  const [calorieTuning, setCalorieTuning] = useState(0);
  const [foodDb, setFoodDb] = useState({});
  const [dailyLog, setDailyLog] = useState([]);
  
  // STATI MODULI (Pasti, Acqua, Allenamento, Zen)
  const [mealType, setMealType] = useState('cena');
  const [drawerMealTime, setDrawerMealTime] = useState(12);
  const [drawerMealTimeStr, setDrawerMealTimeStr] = useState('12:00');
  const [foodNameInput, setFoodNameInput] = useState('');
  const [foodWeightInput, setFoodWeightInput] = useState('');
  const [addedFoods, setAddedFoods] = useState([]);
  const [selectedFoodForCard, setSelectedFoodForCard] = useState(null);
  
  const [foodDropdownSuggestions, setFoodDropdownSuggestions] = useState([]);
  const [showFoodDropdown, setShowFoodDropdown] = useState(false);
  const [isGeneratingFood, setIsGeneratingFood] = useState(false);
  const [isBarcodeScannerOpen, setIsBarcodeScannerOpen] = useState(false);
  const barcodeVideoRef = useRef(null);
  const barcodeStreamRef = useRef(null);
  const barcodeScanIntervalRef = useRef(null);
  
  const [selectedFoodForInfo, setSelectedFoodForInfo] = useState(null);
  const [selectedFoodForEdit, setSelectedFoodForEdit] = useState(null);
  const [nutrientModal, setNutrientModal] = useState(null);
  const [editQuantityValue, setEditQuantityValue] = useState('');
  const [showChoiceModal, setShowChoiceModal] = useState(false);
  const [selectedNodeReport, setSelectedNodeReport] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [userProfile, setUserProfile] = useState({
    gender: 'M',
    age: 30,
    weight: 75,
    height: 175,
    activityLevel: '1.55',
    goal: 'maintain'
  });
  const [userTargets, setUserTargets] = useState({ ...DEFAULT_TARGETS });

  const [workoutType, setWorkoutType] = useState('pesi');
  const [workoutKcal, setWorkoutKcal] = useState(300);
  const [workoutStartTime, setWorkoutStartTime] = useState(18);
  const [workoutEndTime, setWorkoutEndTime] = useState(19);
  const [workoutMuscles, setWorkoutMuscles] = useState([]);
  const [editingWorkoutId, setEditingWorkoutId] = useState(null);
  const [editingMealId, setEditingMealId] = useState(null);

  const [waterIntake, setWaterIntake] = useState(0);
  const dailyWaterGoal = userTargets.water ?? 2500; 
  const [isZenActive, setIsZenActive] = useState(false);

  // AI ASSISTANT E CLUSTER
  const [apiKeys, setApiKeys] = useState(() => JSON.parse(localStorage.getItem('ghost_api_cluster')) || ['']);
  const [activeKeyIndex, setActiveKeyIndex] = useState(0);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState([
    { sender: 'ai', text: 'VYTA SYS ONLINE. Interfaccia Premium e Motore Biochimico allineati.' }
  ]);
  const chatEndRef = useRef(null);
  const lastLogFromFirebaseRef = useRef(null);
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);

  const [fullStorico, setFullStorico] = useState(null);
  const [fullHistory, setFullHistory] = useState({});
  const [showReport, setShowReport] = useState(false);
  const [showTelemetryPopup, setShowTelemetryPopup] = useState(false);
  const [reportPeriod, setReportPeriod] = useState('7');
  const [currentDateObj, setCurrentDateObj] = useState(() => new Date());

  const currentTrackerDate = useMemo(() => {
    const offset = currentDateObj.getTimezoneOffset() * 60000;
    return new Date(currentDateObj.getTime() - offset).toISOString().slice(0, 10);
  }, [currentDateObj]);

  const [idealStrategy, setIdealStrategy] = useState(() => {
    const saved = localStorage.getItem('vyta_idealStrategy');
    return saved ? JSON.parse(saved) : { colazione: 400, pranzo: 700, spuntino: 250, cena: 500, allenamento: 300 };
  });

  const [manualNodes, setManualNodes] = useState(() => {
    const saved = localStorage.getItem('vyta_timeline');
    const parsed = saved ? JSON.parse(saved) : [
      { id: 'lavoro_mat', type: 'work', time: 9, duration: 4, kcal: 400, icon: '💼' },
      { id: 'lavoro_pom', type: 'work', time: 14, duration: 4, kcal: 400, icon: '💼' },
      { id: 'allenamento', type: 'workout', time: 18, duration: 1, kcal: 300, icon: '🏋️' }
    ];
    return (Array.isArray(parsed) ? parsed : []).filter(n => n.type === 'work' || n.type === 'workout');
  });
  const [draggingNode, setDraggingNode] = useState(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const timelineContainerRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const pendingClickRef = useRef(null);
  const dragOffsetYRef = useRef(0);
  const miniTimelinePastoRef = useRef(null);
  const miniTimelineActivityRef = useRef(null);
  const currentTrackerDateRef = useRef(currentTrackerDate);
  useEffect(() => { currentTrackerDateRef.current = currentTrackerDate; }, [currentTrackerDate]);

  // ============================================================================
  // COMPUTED CON RETROCOMPATIBILITÀ
  // ============================================================================

  const getStrategyKey = (mealType) => {
    const map = {
      'merenda1': 'colazione',
      'colazione': 'colazione',
      'merenda2': 'spuntino',
      'spuntino': 'spuntino',
      'snack': 'spuntino',
      'pranzo': 'pranzo',
      'cena': 'cena'
    };
    return map[mealType] || mealType;
  };

  const computedMealNodes = useMemo(() => {
    const bySlot = {};
    (dailyLog || []).forEach(f => {
      const slotKey = getSlotKey(f);
      if (slotKey) {
        if (!bySlot[slotKey]) {
          bySlot[slotKey] = {
            mealType: toCanonicalMealType(f.mealType),
            originalTypes: new Set(),
            time: typeof f.mealTime === 'number' && !Number.isNaN(f.mealTime) ? f.mealTime : 12,
            strategyKey: getStrategyKey(toCanonicalMealType(f.mealType))
          };
        }
        bySlot[slotKey].originalTypes.add(f.mealType);
      }
    });

    return Object.values(bySlot).map(m => ({
      id: `${m.mealType}_${m.time}`,
      type: 'meal',
      time: m.time,
      strategyKey: m.strategyKey,
      originalTypes: Array.from(m.originalTypes),
      icon: getMealIcon(m.mealType)
    }));
  }, [dailyLog]);

  const allNodes = useMemo(() => {
    return [...computedMealNodes, ...manualNodes].sort((a, b) => a.time - b.time);
  }, [computedMealNodes, manualNodes]);

  useEffect(() => {
    localStorage.setItem('vyta_timeline', JSON.stringify(manualNodes));
  }, [manualNodes]);

  useEffect(() => {
    if (!fullStorico || typeof fullStorico !== 'object') return;
    if (currentTrackerDateRef.current !== getTodayString()) return;
    const todayKey = TRACKER_STORICO_KEY(getTodayString());
    const todayNode = fullStorico[todayKey];
    if (todayNode?.manualNodes?.length > 0) {
      setManualNodes(todayNode.manualNodes);
      return;
    }
    const keys = Object.keys(fullStorico).filter(k => k.startsWith('trackerStorico_'));
    keys.sort((a, b) => b.localeCompare(a));
    for (const key of keys) {
      if (key === todayKey) continue;
      const node = fullStorico[key];
      const nodes = node?.manualNodes;
      if (Array.isArray(nodes) && nodes.length > 0) {
        setManualNodes(nodes);
        break;
      }
    }
  }, [fullStorico]);

  useEffect(() => {
    localStorage.setItem('vyta_idealStrategy', JSON.stringify(idealStrategy));
  }, [idealStrategy]);

  useEffect(() => {
    let unsubToday = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (!user) {
        unsubToday?.();
        setIsInitialLoadComplete(false);
        return;
      }
      setUserUid(user.uid);
      setIsAuthenticated(true);
      setIsInitialLoadComplete(false);
      const today = getTodayString();
      const basePath = `users/${user.uid}/tracker_data`;

      get(ref(db, basePath)).then(snap => {
        const tree = snap.exists() ? snap.val() : null;
        setFullStorico(tree);
        setFullHistory(tree || {});
        setDailyLog(getLogFromStoricoTree(tree, today));
        unsubToday = onValue(ref(db, `${basePath}/${TRACKER_STORICO_KEY(today)}`), (liveSnap) => {
          if (liveSnap.exists() && currentTrackerDateRef.current === getTodayString()) {
            const incomingLog = liveSnap.val()?.log ?? [];
            const normalized = normalizeLogData(Array.isArray(incomingLog) ? incomingLog : Object.values(incomingLog || {}));
            lastLogFromFirebaseRef.current = JSON.stringify(normalized);
            setDailyLog(normalized);
          }
        });
        setIsInitialLoadComplete(true);
      });

      get(ref(db, `users/${user.uid}/profile_targets`)).then(profileSnap => {
        if (profileSnap.exists()) {
          const data = profileSnap.val();
          if (data.profile) setUserProfile(prev => ({ ...prev, ...data.profile }));
          if (data.targets) setUserTargets(prev => ({ ...prev, ...data.targets }));
        }
      });

      get(ref(db, `${basePath}/trackerFoodDatabase`)).then(s => { if (s.exists()) setFoodDb(s.val()); });
    });
    return () => { unsubAuth(); unsubToday?.(); };
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsBooting(true);
    try {
      await signInWithEmailAndPassword(auth, loginEmail, loginPassword);
    } catch (error) {
      alert("ACCESSO NEGATO: Controlla le credenziali.");
      setIsBooting(false);
    }
  };

  useEffect(() => {
    if(!isAuthenticated) return;
    const updateTime = () => {
      const now = new Date();
      let decimalTime = now.getHours() + now.getMinutes() / 60;
      setCurrentTime(decimalTime < 8 ? 8 : decimalTime > 23 ? 23 : decimalTime);
    };
    updateTime(); 
    const interval = setInterval(updateTime, 60000); 
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  /** stripUndefined: rimuove undefined ricorsivamente per payload Firebase. */
  const stripUndefined = (obj, depth = 0) => {
    const MAX_STRIP_DEPTH = 25;
    if (depth > MAX_STRIP_DEPTH) return obj;
    if (obj === undefined) return null;
    if (obj === null) return null;
    if (Array.isArray(obj)) return obj.map((v) => stripUndefined(v, depth + 1)).filter((v) => v !== undefined);
    if (typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = stripUndefined(obj[k], depth + 1);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return obj;
  };

  /** Sincronizzazione esplicita su Firebase. Legge uid da auth.currentUser per evitare stale closures. */
  const syncDatiFirebase = useCallback((nuovoLog, nuoviNodi) => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      console.warn("⚠️ Firebase Sync interrotto: Nessun utente loggato rilevato da auth.currentUser");
      return;
    }
    const uid = currentUser.uid;

    console.log("🔄 Preparazione salvataggio su Firebase per UID:", uid);

    try {
      const dateStr = currentTrackerDate;
      const logForFirebase = denormalizeLogForFirebase(nuovoLog || []);
      const mealTimes = (nuovoLog || []).filter(i => i.type === 'food').reduce((acc, f) => ({
        ...acc,
        [f.mealType]: f.mealTime ?? 12
      }), {});
      const sanitizedLog = stripUndefined(logForFirebase);
      const sanitizedNodes = stripUndefined(nuoviNodi || []);
      const payload = {
        data: dateStr,
        log: sanitizedLog,
        mealTimes,
        manualNodes: sanitizedNodes
      };
      const sanitized = stripUndefined(payload);

      const dbPath = `users/${uid}/tracker_data/${TRACKER_STORICO_KEY(dateStr)}`;
      console.log("📁 Percorso di salvataggio:", dbPath);

      set(ref(db, dbPath), sanitized)
        .then(() => {
          setFullHistory(prev => ({ ...prev, [TRACKER_STORICO_KEY(dateStr)]: sanitized }));
          console.log("✅ Dati salvati con successo su Firebase!");
        })
        .catch(err => console.error("❌ Errore critico durante il salvataggio Firebase:", err));
    } catch (error) {
      console.error("❌ Errore durante la preparazione del payload Firebase:", error);
    }
  }, [currentTrackerDate]);

  const saveProfileToFirebase = (newProfile, newTargets) => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    const uid = currentUser.uid;
    set(ref(db, `users/${uid}/profile_targets`), {
      profile: newProfile,
      targets: newTargets
    }).then(() => {
      alert("✅ Profilo e Target salvati con successo!");
      setShowProfile(false);
    }).catch(err => console.error("Errore salvataggio profilo:", err));
  };

  const calculateSmartTargets = () => {
    const { gender, age, weight, height, activityLevel, goal } = userProfile;
    const w = parseFloat(weight) || 75;
    const h = parseFloat(height) || 175;
    const a = parseFloat(age) || 30;
    let bmr = (10 * w) + (6.25 * h) - (5 * a);
    bmr += (gender === 'M') ? 5 : -161;
    let tdee = bmr * parseFloat(activityLevel || '1.55');
    if (goal === 'lose') tdee -= 500;
    if (goal === 'gain') tdee += 300;
    const kcal = Math.round(tdee);
    const prot = Math.round(w * 2.0);
    const fat = Math.round((kcal * 0.25) / 9);
    const carb = Math.round((kcal - (prot * 4) - (fat * 9)) / 4);
    const water = Math.round(w * 35);
    setUserTargets(prev => ({
      ...prev,
      kcal,
      prot,
      carb,
      fatTotal: fat,
      fat: fat,
      water
    }));
  };

  const changeDate = (daysOffset) => {
    const newDate = new Date(currentDateObj);
    newDate.setDate(newDate.getDate() + daysOffset);
    setCurrentDateObj(newDate);

    const offset = newDate.getTimezoneOffset() * 60000;
    const dateStr = new Date(newDate.getTime() - offset).toISOString().slice(0, 10);
    const dayData = fullHistory[`trackerStorico_${dateStr}`];

    if (dayData) {
      const rawLog = Array.isArray(dayData.log) ? dayData.log : Object.values(dayData.log || {});
      setDailyLog(normalizeLogData(rawLog));
      setManualNodes(Array.isArray(dayData.manualNodes) ? dayData.manualNodes : []);
    } else {
      setDailyLog([]);
      setManualNodes([]);
    }
  };

  const REPORT_NUTRIENT_KEYS = ['kcal', 'prot', 'carb', 'fatTotal', 'fibre', 'vitc', 'vitD', 'omega3', 'mg', 'k', 'fe', 'ca'];
  const generateReportData = () => {
    const days = parseInt(reportPeriod, 10) || 7;
    const now = new Date();
    let totalDaysFound = 0;
    const aggregated = {};
    REPORT_NUTRIENT_KEYS.forEach(k => { aggregated[k] = 0; });

    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayData = fullHistory[`trackerStorico_${dateStr}`];

      if (dayData && dayData.log) {
        const rawLog = Array.isArray(dayData.log) ? dayData.log : Object.values(dayData.log || []);
        const flatLog = normalizeLogData(rawLog);
        const foodItems = flatLog.filter(item => item.type === 'food');
        if (foodItems.length > 0) totalDaysFound++;
        foodItems.forEach(food => {
          REPORT_NUTRIENT_KEYS.forEach(key => {
            const val = key === 'kcal' ? (food.kcal ?? food.cal) : food[key];
            aggregated[key] += (parseFloat(val) || 0);
          });
        });
      }
    }

    if (totalDaysFound === 0) return null;
    const averages = {};
    REPORT_NUTRIENT_KEYS.forEach(key => {
      averages[key] = aggregated[key] / totalDaysFound;
    });
    return { averages, daysFound: totalDaysFound };
  };

  useEffect(() => {
    const q = (foodNameInput || '').trim().toLowerCase();
    if (!q) {
      setFoodDropdownSuggestions([]);
      return;
    }
    const keys = Object.keys(foodDb || {});
    const matches = keys
      .filter(k => {
        const d = foodDb[k];
        const desc = (d?.desc || d?.name || '').toLowerCase();
        return desc.includes(q);
      })
      .slice(0, 10)
      .map(k => ({ key: k, desc: foodDb[k]?.desc || foodDb[k]?.name || k }));
    setFoodDropdownSuggestions(matches);
  }, [foodNameInput, foodDb]);

  useEffect(() => {
    if (!draggingNode) return;
    setDragOffsetY(0);
    dragOffsetYRef.current = 0;
    const el = timelineContainerRef.current;
    const { id: dragId, edge: dragEdge, type: dragType, originalTime, originalDuration } = draggingNode;

    const onMove = (e) => {
      if (!el || !draggingNode) return;
      const rect = el.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const offsetY = e.clientY - centerY;
      dragOffsetYRef.current = offsetY;
      setDragOffsetY(offsetY);
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const hour = Math.round(percent * 24 * 4) / 4;

      if (dragType === 'meal') {
        const { itemIds } = draggingNode;
        setDailyLog(prev => {
          const next = prev.map(item =>
            itemIds && itemIds.includes(item.id) ? { ...item, mealTime: hour } : item
          );
          syncDatiFirebase(next, manualNodes);
          return next;
        });
      } else {
        setManualNodes(prev => {
          const next = prev.map(n => {
            if (n.id !== dragId) return n;
            if (n.type === 'work') {
              if (dragEdge === 'start') {
                const end = n.time + (n.duration || 1);
                const newTime = Math.min(hour, end - 0.25);
                return { ...n, time: newTime, duration: end - newTime };
              }
              if (dragEdge === 'end') {
                const newEnd = Math.max(hour, n.time + 0.25);
                return { ...n, duration: newEnd - n.time };
              }
              if (dragEdge === 'all') {
                return { ...n, time: hour };
              }
            }
            return { ...n, time: hour };
          });
          syncDatiFirebase(dailyLog, next);
          return next;
        });
      }
    };

    const onUp = () => {
      const isOutside = Math.abs(dragOffsetYRef.current) > 50;
      if (isOutside) {
        const confirmDelete = window.confirm('Vuoi eliminare questo elemento?');
        if (confirmDelete) {
          if (dragType === 'meal') {
            const { itemIds } = draggingNode;
            setDailyLog(prev => {
              const next = prev.filter(item => !(itemIds && itemIds.includes(item.id)));
              syncDatiFirebase(next, manualNodes);
              return next;
            });
          } else {
            setDailyLog(prev => {
              const newLog = prev.filter(item => item.id !== dragId);
              setManualNodes(prevN => {
                const newNodes = prevN.filter(n => n.id !== dragId);
                syncDatiFirebase(newLog, newNodes);
                return newNodes;
              });
              return newLog;
            });
          }
        } else {
          if (dragType === 'meal') {
            const { itemIds, originalTime: origTime } = draggingNode;
            setDailyLog(prev => {
              const next = prev.map(item =>
                itemIds && itemIds.includes(item.id) ? { ...item, mealTime: origTime } : item
              );
              syncDatiFirebase(next, manualNodes);
              return next;
            });
          } else {
            setManualNodes(prev => {
              const next = prev.map(n =>
                n.id === dragId ? { ...n, time: originalTime, duration: originalDuration ?? n.duration } : n
              );
              syncDatiFirebase(dailyLog, next);
              return next;
            });
          }
        }
      }
      setDragOffsetY(0);
      dragOffsetYRef.current = 0;
      setDraggingNode(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [draggingNode]);

  useEffect(() => {
    if (activeAction === 'ai_chat' && chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, activeAction]);

  useEffect(() => { if (!isDrawerOpen) setIsZenActive(false); }, [isDrawerOpen]);

  useEffect(() => {
    if (isDrawerOpen && activeAction === 'pasto') setDrawerMealTimeStr(decimalToTimeStr(drawerMealTime));
  }, [isDrawerOpen, activeAction, drawerMealTime]);

  // Motore biochimico
  const baseKcal = (userTargets.kcal ?? STRATEGY_PROFILES[dayProfile].kcal) + calorieTuning;
  const { totali, obiettiviPasti } = useBiochimico(dailyLog, baseKcal);
  const targetKcal = baseKcal + (totali?.workout ?? 0);

  const openDrawer = () => { setActiveAction(null); setIsDrawerOpen(true); };
  const closeDrawer = () => { setIsDrawerOpen(false); setTimeout(() => setActiveAction(null), 400); };

  // ============================================================================
  // FUNZIONI CRITICHE CON RETROCOMPATIBILITÀ
  // ============================================================================

  /**
   * Carica un pasto nel costruttore. Accetta mealType o id composito "mealType_time" (es. snack_16.5).
   * Con id composito carica solo i food con quel mealType e quel mealTime.
   */
  const loadMealToConstructor = (mTypeOrId) => {
    setAddedFoods([]);
    setEditingMealId(mTypeOrId);

    let items = (dailyLog || []).filter(item => getSlotKey(item) === String(mTypeOrId));

    if (items.length === 0) {
      const canonical = toCanonicalMealType(String(mTypeOrId).split('_')[0]);
      const equivalents = getEquivalentMealTypes(canonical);
      items = (dailyLog || []).filter(item => item.type === 'food' && equivalents.includes(item.mealType));
    }

    items = items.map(f => ({ ...f }));
    const canonical = items.length > 0 ? toCanonicalMealType(items[0].mealType) : toCanonicalMealType(String(mTypeOrId).split('_')[0]);

    setMealType(canonical);
    const t = items.length > 0 && typeof items[0].mealTime === 'number' ? items[0].mealTime : getDefaultMealTime(canonical);
    setDrawerMealTime(t);
    setDrawerMealTimeStr(decimalToTimeStr(t));
    setAddedFoods(items);
    setActiveAction('pasto');
    setIsDrawerOpen(true);
  };

  const getDefaultMealTime = (mealTypeKey) => {
    const equivalents = getEquivalentMealTypes(mealTypeKey);
    
    // Cerca nel dailyLog corrente
    const first = (dailyLog || []).find(item => 
      item.type === 'food' && equivalents.includes(item.mealType)
    );
    if (first != null && typeof first.mealTime === 'number') return first.mealTime;
    
    if (!fullStorico) return 12;
    const keys = Object.keys(fullStorico).filter(k => k.startsWith('trackerStorico_'));
    keys.sort((a, b) => b.localeCompare(a));
    const todayKey = TRACKER_STORICO_KEY(getTodayString());
    
    for (const key of keys) {
      if (key === todayKey) continue;
      const dayData = fullStorico[key];
      // Cerca in mealTimes con qualsiasi equivalente
      for (const eq of equivalents) {
        const t = dayData?.mealTimes?.[eq];
        if (typeof t === 'number') return t;
      }
    }
    return 12;
  };

  const handleTimeInput = (value) => {
    const digits = (value || '').replace(/\D/g, '');
    if (digits.length === 0) {
      setDrawerMealTimeStr('');
      setDrawerMealTime(12);
      return;
    }
    let formatted = digits.slice(0, 4);
    if (formatted.length > 2) formatted = formatted.slice(0, 2) + ':' + formatted.slice(2);
    if (digits.length > 4) formatted = digits.slice(0, 2) + ':' + digits.slice(2, 4);
    setDrawerMealTimeStr(formatted);
    const [hh, mm] = formatted.includes(':') ? formatted.split(':') : [formatted.slice(0, 2) || '0', formatted.slice(2) || '0'];
    const h = Math.min(23, Math.max(0, parseInt(hh, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt(mm, 10) || 0));
    setDrawerMealTime(h + m / 60);
  };

  const parseTimeStrToDecimal = (value) => {
    const digits = (value || '').replace(/\D/g, '');
    if (digits.length === 0) return 12;
    const formatted = digits.length > 2 ? digits.slice(0, 2) + ':' + digits.slice(2, 4) : digits;
    const [hh, mm] = formatted.includes(':') ? formatted.split(':') : [formatted.slice(0, 2) || '0', formatted.slice(2) || '0'];
    const h = Math.min(23, Math.max(0, parseInt(hh, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt(mm, 10) || 0));
    return h + m / 60;
  };

  const getLastQuantityForFood = (desc) => {
    if (!fullStorico || !desc) return null;
    const keys = Object.keys(fullStorico).filter(k => k.startsWith('trackerStorico_'));
    keys.sort((a, b) => b.localeCompare(a));
    const norm = (s) => (s || '').toLowerCase().trim();
    const target = norm(desc);
    for (const key of keys) {
      const log = fullStorico[key]?.log;
      if (!Array.isArray(log)) continue;
      const flat = normalizeLogData(log);
      const found = flat.filter(i => i.type === 'food').find(i => 
        norm(i.desc || i.name) === target || 
        norm(i.desc || i.name).includes(target) || 
        target.includes(norm(i.desc || i.name))
      );
      if (found != null && (found.qta != null || found.weight != null)) {
        return String(found.qta ?? found.weight ?? '');
      }
    }
    return null;
  };

  const fetchOpenFoodFactsProduct = async (barcode) => {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,ingredients_text_it,ingredients_text,nutriments`);
    const data = await res.json();
    if (data.status === 0 || !data.product) return null;
    const p = data.product;
    const nut = p.nutriments || {};
    const toNum = (v) => (v != null && v !== '' ? parseFloat(v) : undefined);
    const entryPer100 = {
      desc: p.product_name || `Barcode ${barcode}`,
      kcal: toNum(nut['energy-kcal_100g']) ?? toNum(nut['energy_100g']) ? (nut['energy_100g'] / 4.184) : undefined,
      prot: toNum(nut.proteins_100g),
      carb: toNum(nut.carbohydrates_100g),
      fatTotal: toNum(nut.fat_100g),
      fibre: toNum(nut.fiber_100g)
    };
    ['sugars_100g', 'saturated-fat_100g', 'salt_100g', 'sodium_100g', 'calcium_100g', 'iron_100g', 'potassium_100g', 'vitamin-c_100g', 'vitamin-d_100g'].forEach((key, i) => {
      const our = ['zuccheri', 'fatSat', 'sale', 'na', 'ca', 'fe', 'k', 'vitc', 'vitD'][i];
      if (our && nut[key] != null) entryPer100[our] = parseFloat(nut[key]);
    });
    return entryPer100;
  };

  const handleBarcodeDetected = useCallback(async (barcode) => {
    setIsBarcodeScannerOpen(false);
    if (barcodeStreamRef.current) {
      barcodeStreamRef.current.getTracks().forEach(t => t.stop());
      barcodeStreamRef.current = null;
    }
    if (barcodeScanIntervalRef.current) clearInterval(barcodeScanIntervalRef.current);
    try {
      const entryPer100 = await fetchOpenFoodFactsProduct(barcode);
      const name = entryPer100?.desc || `Barcode ${barcode}`;
      if (entryPer100 && userUid) {
        Object.keys(TARGETS).forEach(g => Object.keys(TARGETS[g] || {}).forEach(k => { 
          if (entryPer100[k] == null) entryPer100[k] = getDefaultNutrientValue(k); 
        }));
        if (entryPer100.kcal == null) entryPer100.kcal = getDefaultNutrientValue('kcal');
        const newKey = `food_${Date.now()}_${name.replace(/\s+/g, '_').slice(0, 20)}`;
        const basePath = `users/${userUid}/tracker_data`;
        await set(ref(db, `${basePath}/trackerFoodDatabase/${newKey}`), entryPer100);
        setFoodDb(prev => ({ ...prev, [newKey]: entryPer100 }));
      }
      setFoodNameInput(name);
      setFoodWeightInput(getLastQuantityForFood(name) || '100');
      setTimeout(() => document.getElementById('weight-input')?.focus(), 100);
    } catch (e) {
      setFoodNameInput(`Barcode ${barcode}`);
      setFoodWeightInput('100');
      setTimeout(() => document.getElementById('weight-input')?.focus(), 100);
    }
  }, [foodDb, userUid]);

  useEffect(() => {
    if (!isBarcodeScannerOpen || !barcodeVideoRef.current) return;
    if (!('BarcodeDetector' in window)) {
      alert('Il browser non supporta la scansione barcode. Prova Chrome su Android.');
      setIsBarcodeScannerOpen(false);
      return;
    }
    let stream = null;
    const barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => {
        stream = s;
        barcodeStreamRef.current = s;
        if (barcodeVideoRef.current) {
          barcodeVideoRef.current.srcObject = s;
          barcodeVideoRef.current.play();
        }
        barcodeScanIntervalRef.current = setInterval(async () => {
          if (!barcodeVideoRef.current || !stream) return;
          try {
            const barcodes = await barcodeDetector.detect(barcodeVideoRef.current);
            if (barcodes.length > 0) {
              const code = barcodes[0].rawValue;
              handleBarcodeDetected(code);
            }
          } catch (_) {}
        }, 200);
      })
      .catch(() => {
        alert('Impossibile accedere alla fotocamera.');
        setIsBarcodeScannerOpen(false);
      });
    return () => {
      if (barcodeScanIntervalRef.current) clearInterval(barcodeScanIntervalRef.current);
      if (stream) stream.getTracks().forEach(t => t.stop());
      barcodeStreamRef.current = null;
    };
  }, [isBarcodeScannerOpen, handleBarcodeDetected]);

  /** Stima media verosimile per nutriente mancante (mai 0: usa contesto nome o media). */
  const getAverageEstimate = useCallback((nutrientKey, foodDesc = '') => {
    const desc = (foodDesc || '').toLowerCase();
    const isProteico = /pollo|carne|pesce|tonno|salmone|manzo|petto|bresaola|prosciutto|uovo|tofu|legum|fagiol|ceci|lenticch|proteina/.test(desc);
    const isCarboidrato = /pasta|pane|riso|patata|cereal|pizza|biscott|dolce|zucchero|miele|frutta|banana|mela/.test(desc);
    const isGrasso = /olio|avocado|frutta secca|mandorla|noci|semi|burro/.test(desc);
    if (nutrientKey === 'prot') return isProteico ? 18 : (isCarboidrato ? 6 : 10);
    if (nutrientKey === 'carb') return isCarboidrato ? 45 : (isProteico ? 2 : 15);
    if (nutrientKey === 'fatTotal' || nutrientKey === 'fat') return isGrasso ? 15 : (isProteico ? 5 : 8);
    if (nutrientKey === 'kcal' || nutrientKey === 'cal') {
      const p = getAverageEstimate('prot', foodDesc);
      const c = getAverageEstimate('carb', foodDesc);
      const f = getAverageEstimate('fatTotal', foodDesc);
      return Math.round((p * 4 + c * 4 + f * 9)) || 120;
    }
    const def = getDefaultNutrientValue(nutrientKey);
    return def > 0 ? def : (nutrientKey === 'fibre' ? 3 : nutrientKey === 'omega3' ? 0.3 : nutrientKey === 'mg' ? 25 : 10);
  }, []);

  // Estrazione dati da DB
  const estraiDatiFoodDb = useCallback((nome, qta, pastoType) => {
    const foodItem = Object.assign(
      { id: Date.now() + Math.random(), type: 'food', mealType: pastoType, desc: nome, qta, weight: qta, kcal: 0, cal: 0 },
      ...Object.keys(TARGETS).flatMap(g => Object.keys(TARGETS[g]).map(k => ({ [k]: undefined })))
    );
    const dbKey = Object.keys(foodDb).find(k => foodDb[k].desc?.toLowerCase().includes(nome.toLowerCase()));
    if (dbKey) {
      const dbF = foodDb[dbKey];
      Object.keys(dbF || {}).forEach(k => {
        if (typeof dbF[k] === 'number' && k !== 'id') foodItem[k] = (dbF[k] / 100) * qta;
      });
      foodItem.kcal = foodItem.kcal || foodItem.cal || 0;
      foodItem.cal = foodItem.cal ?? foodItem.kcal;
      const macroKeys = ['kcal', 'cal', 'prot', 'carb', 'fatTotal', 'fibre'];
      Object.keys(TARGETS).forEach(g => Object.keys(TARGETS[g]).forEach(k => {
        if (foodItem[k] == null || foodItem[k] === 0) {
          foodItem[k] = macroKeys.includes(k)
            ? (getAverageEstimate(k, nome) / 100) * qta || getDefaultNutrientValue(k)
            : getDefaultNutrientValue(k);
        }
      }));
      if (!foodItem.kcal || foodItem.kcal === 0) foodItem.kcal = (getAverageEstimate('kcal', nome) / 100) * qta || getDefaultNutrientValue('kcal');
    } else {
      const macroKeys = ['kcal', 'cal', 'prot', 'carb', 'fatTotal', 'fibre'];
      foodItem.kcal = (getAverageEstimate('kcal', nome) / 100) * qta || getDefaultNutrientValue('kcal');
      foodItem.cal = foodItem.kcal;
      foodItem.prot = (getAverageEstimate('prot', nome) / 100) * qta || getDefaultNutrientValue('prot');
      foodItem.carb = (getAverageEstimate('carb', nome) / 100) * qta || getDefaultNutrientValue('carb');
      foodItem.fatTotal = (getAverageEstimate('fatTotal', nome) / 100) * qta || getDefaultNutrientValue('fatTotal');
      Object.values(TARGETS).forEach(g => Object.keys(g || {}).forEach(k => {
        if (foodItem[k] == null)
          foodItem[k] = macroKeys.includes(k) ? (getAverageEstimate(k, nome) / 100) * qta || getDefaultNutrientValue(k) : getDefaultNutrientValue(k);
      }));
    }
    return foodItem;
  }, [foodDb, getAverageEstimate]);

  const handleAddFoodManual = () => {
    if (!foodNameInput || !foodWeightInput) return;
    const item = estraiDatiFoodDb(foodNameInput.trim(), parseFloat(foodWeightInput), mealType);
    setAddedFoods([item, ...addedFoods]);
    setFoodNameInput(''); 
    setFoodWeightInput('');
  };

  const saveMealToDiary = () => {
    const timeToUse = typeof drawerMealTime === 'number' && !Number.isNaN(drawerMealTime) ? drawerMealTime : 12;
    const uniqueBatchId = Date.now();

    const mealItems = addedFoods.map((f, index) => ({
      ...f,
      mealType: mealType,
      mealTime: timeToUse,
      id: f.id ? f.id : `f_${uniqueBatchId}_${index}`
    }));

    setDailyLog(prev => {
      let filtered = prev;
      if (editingMealId) {
        filtered = prev.filter(item => getSlotKey(item) !== editingMealId);
      }
      const nuovoLog = [...mealItems, ...filtered];
      syncDatiFirebase(nuovoLog, manualNodes);
      return nuovoLog;
    });

    setAddedFoods([]);
    setEditingMealId(null);
    closeDrawer();
  };

  const handleNodeClick = (node) => {
    setSelectedNodeReport(node);
  };

  const LONG_PRESS_MS = 400;
  const startLongPress = (node, edge, e) => {
    e.preventDefault();
    e.stopPropagation();
    pendingClickRef.current = { node };
    const removeListeners = () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
    const onPointerUp = () => {
      removeListeners();
      if (pendingClickRef.current) {
        handleNodeClick(pendingClickRef.current.node);
        pendingClickRef.current = null;
      }
    };
    const onPointerMove = () => {
      removeListeners();
      pendingClickRef.current = null;
    };

    let itemIds = [];
    if (node.type === 'meal') {
      itemIds = (dailyLog || [])
        .filter(item => getSlotKey(item) === String(node.id))
        .map(i => i.id);
    }

    longPressTimerRef.current = setTimeout(() => {
      pendingClickRef.current = null;
      removeListeners();
      setDraggingNode({
        id: node.id,
        edge,
        type: node.type,
        originalTime: node.time,
        originalDuration: node.duration,
        itemIds
      });
    }, LONG_PRESS_MS);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
  };

  const handleAddWater = (amount) => { 
    setWaterIntake(prev => prev + amount < 0 ? 0 : prev + amount); 
  };
  
  const handleSaveWorkout = () => {
    const isWork = workoutType === 'lavoro';
    const duration = Math.max(0.25, Number(workoutEndTime) - Number(workoutStartTime));
    const finalId = editingWorkoutId || (isWork ? 'work_' : 'workout_') + Date.now();

    const descMuscles = workoutMuscles.length > 0 ? ` (${workoutMuscles.join(' + ')})` : '';
    const desc = workoutType === 'pesi' ? `Sollevamento Pesi${descMuscles}` :
                 workoutType === 'cardio' ? 'Cardio / Corsa' :
                 workoutType === 'hiit' ? 'HIIT / Circuito' : 'Attività Lavorativa';

    const nodeData = { id: finalId, type: isWork ? 'work' : 'workout', time: Number(workoutStartTime), duration, kcal: workoutKcal, icon: isWork ? '💼' : '🏋️', subType: workoutType, muscles: workoutMuscles };
    const logData = {
      id: finalId,
      type: 'workout',
      workoutType,
      desc,
      name: isWork ? 'Lavoro' : desc,
      kcal: workoutKcal,
      cal: workoutKcal,
      duration
    };

    setDailyLog(prev => {
      const newLog = prev.some(n => n.id === finalId)
        ? prev.map(n => n.id === finalId ? logData : n)
        : [logData, ...prev];
      setManualNodes(prevN => {
        const newNodes = prevN.some(n => n.id === finalId)
          ? prevN.map(n => n.id === finalId ? nodeData : n)
          : [...prevN, nodeData];
        syncDatiFirebase(newLog, newNodes);
        return newNodes;
      });
      return newLog;
    });

    setEditingWorkoutId(null);
    setWorkoutMuscles([]);
    closeDrawer();
  };

  const PASTO_ALIAS_TO_ID = { colazione: 'merenda1', 'spuntino mattina': 'merenda1', pranzo: 'pranzo', 'spuntino pomeriggio': 'merenda2', cena: 'cena', snack: 'snack' };
  const processTestoAI = (testo) => {
    let trovati = 0;
    const batchId = Date.now();
    const nuoviAlimenti = [];
    const nuoviWorkout = [];

    const regexFood = /\[(.*?)\s*\|\s*([0-9.,]+)\s*\|\s*(colazione|spuntino\s*mattina|pranzo|spuntino\s*pomeriggio|cena|snack)\]/gi;
    let matchFood;
    while ((matchFood = regexFood.exec(testo)) !== null) {
      trovati++;
      const nome = matchFood[1].trim();
      const qta = parseFloat(String(matchFood[2]).replace(',', '.')) || 0;
      const pastoString = String(matchFood[3]).trim().toLowerCase().replace(/\s+/g, ' ');
      const pastoCanonical = PASTO_ALIAS_TO_ID[pastoString] || toCanonicalMealType(pastoString);
      const item = estraiDatiFoodDb(nome, qta, pastoCanonical);
      nuoviAlimenti.push({
        ...item,
        id: `f_${batchId}_${trovati}`,
        mealTime: getDefaultMealTime(pastoCanonical)
      });
    }

    const regexWorkout = /\[ALLENAMENTO:\s*([^|\]]+?)\s*\|\s*([0-9.,]+)\]/gi;
    let matchWorkout;
    while ((matchWorkout = regexWorkout.exec(testo)) !== null) {
      trovati++;
      const desc = matchWorkout[1].trim();
      const kcal = parseFloat(String(matchWorkout[2]).replace(',', '.')) || 0;
      nuoviWorkout.push({
        id: `w_${batchId}_${trovati}`,
        type: 'workout',
        desc,
        name: desc,
        kcal,
        cal: kcal,
        duration: Math.floor(kcal / 6) || 30
      });
    }

    if (trovati > 0) {
      setDailyLog(prev => {
        const nextLog = [...nuoviAlimenti, ...nuoviWorkout, ...prev];
        syncDatiFirebase(nextLog, manualNodes);
        return nextLog;
      });
      alert(`✅ Inseriti ${trovati} elementi dal comando testuale!`);
    } else {
      alert("❌ Nessun comando compatibile trovato nel testo.");
    }
  };

  const removeLogItem = (id) => {
    setDailyLog(prev => {
      const newLog = prev.filter(item => item.id !== id);
      setManualNodes(prevN => {
        const newNodes = prevN.filter(n => n.id !== id);
        syncDatiFirebase(newLog, newNodes);
        return newNodes;
      });
      return newLog;
    });
  };

  const handleMiniTimelineDrag = (e, containerRef, type, currentStart, currentEnd, setterStart, setterEnd) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    const onMove = (moveEvent) => {
      const percent = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      const newTime = Math.round(percent * 24 * 4) / 4;

      if (type === 'point') {
        setterStart(newTime);
      } else if (type === 'bar-start') {
        setterStart(Math.min(newTime, currentEnd - 0.25));
      } else if (type === 'bar-end') {
        setterEnd(Math.max(newTime, currentStart + 0.25));
      } else if (type === 'bar-all') {
        const duration = currentEnd - currentStart;
        const clampedStart = Math.min(24 - duration, newTime);
        setterStart(clampedStart);
        setterEnd(clampedStart + duration);
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // --- CLUSTER AI GEMINI ---
  const handleAddKey = () => { setApiKeys([...apiKeys, '']); };
  const handleKeyChange = (index, value) => { 
    const newKeys = [...apiKeys]; 
    newKeys[index] = value; 
    setApiKeys(newKeys); 
  };
  const handleRemoveKey = (index) => { 
    const newKeys = apiKeys.filter((_, i) => i !== index); 
    if(newKeys.length === 0) newKeys.push(''); 
    setApiKeys(newKeys); 
  };
  const saveApiCluster = () => { 
    localStorage.setItem('ghost_api_cluster', JSON.stringify(apiKeys)); 
    setShowAiSettings(false); 
  };

  const callGeminiAPIWithRotation = async (promptText) => {
    const validKeys = apiKeys.filter(k => k.trim() !== '');
    if (validKeys.length === 0) throw new Error("Nessuna API Key configurata.");
    let attempt = 0;
    while (attempt < validKeys.length) {
      const currentIndex = (activeKeyIndex + attempt) % validKeys.length;
      const currentKey = validKeys[currentIndex];
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${currentKey}`, {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            contents: [{ parts: [{ text: promptText }] }], 
            generationConfig: { temperature: 0.1 } 
          })
        });
        if (!response.ok) { 
          if (response.status === 429) { 
            attempt++; 
            continue; 
          } 
          throw new Error(`Errore Server: ${response.status}`); 
        }
        const data = await response.json();
        if (attempt > 0) setActiveKeyIndex(currentIndex);
        return data.candidates[0].content.parts[0].text;
      } catch (e) { 
        if (attempt === validKeys.length - 1) throw e; 
        attempt++; 
      }
    }
    throw new Error("Cluster API esaurito.");
  };

  const handleChatSubmit = async () => {
    if (!chatInput.trim()) return;
    const userText = chatInput.trim();
    setChatHistory(prev => [...prev, { sender: 'user', text: userText }]);
    setChatInput(''); 
    setChatHistory(prev => [...prev, { sender: 'ai', isTyping: true }]);

    try {
      const energyResult = generateRealEnergyData(allNodes, dailyLog || [], idealStrategy);
      const chartData = energyResult?.chartData || [];
      const energyAt20 = chartData[20]?.energy;

      const systemContext = `
[CONTESTO DI SISTEMA INVISIBILE - NON MENZIONARLO ALL'UTENTE]
Stato attuale cruscotto:
- Timeline (nodi): ${JSON.stringify(allNodes.map(n => ({ id: n.id, type: n.type, time: n.time, duration: n.duration, kcal: n.kcal })))}
- Strategia ideale attuale (kcal): ${JSON.stringify(idealStrategy)}
- Rischio stress serale (energia < 40 alle ore 20): ${energyAt20 != null && energyAt20 < 40 ? 'ALTO (Intervenire)' : 'Basso'}
- Carenza Omega3: ${(Number(totali?.omega3) ?? 0) < 1 ? 'SI' : 'NO'}
- Storico ultimi 3 giorni: ${JSON.stringify(pastDaysStorico.slice(0, 3).map(d => ({ data: d.dataStr, kcal: Math.round(d.calorie), prot: Math.round(d.proteine), deficit: d.deficit })))}

REGOLE TASSATIVE PER LA TUA RISPOSTA:
1. Se l'utente chiede una strategia o descrive la giornata, analizza i dati. Se vedi rischio stress serale, modifica la strategia per aggiungere un pasto tattico prima di cena.
2. Quando un valore nutrizionale non è disponibile per la compilazione automatica, fai una stima e usa il valore medio.
3. Per modificare la strategia o gli orari, devi inserire alla fine della risposta questo comando esatto (puoi omettere i campi che non cambi):
[STRATEGIA: colazione=400, pranzo=700, spuntino=250, cena=500, allenamento=300, orario_allenamento=18]
4. Se l'utente chiede un bilancio, un'analisi dei giorni scorsi o come sta andando la settimana, basati sui dati dello "Storico ultimi 3 giorni" per dare un feedback personalizzato.
`;

      const prompt = systemContext + `\n\nAnalizza: "${userText}". CASO CIBO: Rispondi [AGGIUNGI: nome | grammi | pasto]. Se no grammi, scrivi 0. CASO ALLENAMENTO: Rispondi [ALLENAMENTO: descrizione | kcal]. STIMA kcal se mancano. Rispondi SOLO con i comandi tra parentesi quadre.`;
      const responseText = await callGeminiAPIWithRotation(prompt);
      let foundAny = false; 
      let newLogItems = [];

      const regexFood = /\[AGGIUNGI:\s*([^|\]]+?)\s*\|\s*([0-9.,]+)\s*\|\s*([^\]]+?)\]/gi;
      let matchFood;
      while ((matchFood = regexFood.exec(responseText)) !== null) {
          foundAny = true;
          const grammi = parseFloat(matchFood[2].replace(',', '.'));
          const qta = (typeof grammi === 'number' && !Number.isNaN(grammi) && grammi > 0) ? grammi : 100;
          const pastoF = matchFood[3].trim().toLowerCase();
          
          // Mappa i nomi comuni ai mealType canonici
          const mealTypeMap = {
            'colazione': 'merenda1',
            'merenda': 'merenda1',
            'merenda am': 'merenda1',
            'pranzo': 'pranzo',
            'spuntino': 'snack',
            'merenda pm': 'merenda2',
            'cena': 'cena',
            'snack': 'snack'
          };
          const canonicalMeal = mealTypeMap[pastoF] || pastoF;
          newLogItems.push(estraiDatiFoodDb(matchFood[1].trim(), qta, canonicalMeal));
      }

      const regexWorkout = /\[ALLENAMENTO:\s*([^|\]]+?)\s*\|\s*([0-9.,]+)\]/gi;
      let matchWorkout;
      while ((matchWorkout = regexWorkout.exec(responseText)) !== null) {
          foundAny = true;
          const kcalRaw = parseFloat(matchWorkout[2].replace(',', '.'));
          const kcal = (typeof kcalRaw === 'number' && !Number.isNaN(kcalRaw) && kcalRaw > 0) ? kcalRaw : 300;
          newLogItems.push({ 
            id: Date.now() + Math.random(), 
            type: 'workout', 
            workoutType: 'misto', 
            desc: matchWorkout[1].trim().toUpperCase(), 
            kcal, 
            duration: Math.floor(kcal / 6) 
          });
      }

      const regexStrategia = /\[STRATEGIA:\s*(.+?)\]/gi;
      let matchStrategia;
      while ((matchStrategia = regexStrategia.exec(responseText)) !== null) {
          const pairs = matchStrategia[1].split(',');
          const newStrategy = { ...idealStrategy };
          const timeUpdates = {};
          pairs.forEach(pair => {
              const [key, val] = pair.split('=').map(s => (s || '').trim().toLowerCase());
              const numVal = parseFloat(val);
              if (!isNaN(numVal) && key) {
                  if (key.startsWith('orario_')) {
                      const timeKey = key.replace('orario_', '');
                      timeUpdates[timeKey] = numVal;
                  } else if (newStrategy[key] !== undefined) {
                      newStrategy[key] = numVal;
                  }
              }
          });
          setIdealStrategy(newStrategy);
          if (Object.keys(timeUpdates).length > 0) {
            setManualNodes(prev => {
              const next = prev.map(n => n.id in timeUpdates ? { ...n, time: timeUpdates[n.id] } : n);
              syncDatiFirebase(dailyLog, next);
              return next;
            });
          }
      }

      // Pulisce il testo rimuovendo i comandi tecnici invisibili
      let cleanText = responseText
        .replace(/\[AGGIUNGI:\s*[^\]]+\]/gi, '')
        .replace(/\[ALLENAMENTO:\s*[^\]]+\]/gi, '')
        .replace(/\[STRATEGIA:\s*[^\]]+\]/gi, '')
        .trim();

      if (cleanText === '') {
        cleanText = '✨ Strategia applicata con successo.';
      }

      setChatHistory(prev => {
        const newHist = [...prev];
        newHist.pop(); // Rimuove il typing indicator
        newHist.push({ sender: 'ai', text: cleanText });
        return newHist;
      });

      if (newLogItems.length > 0) setDailyLog(prev => {
        const newLog = [...newLogItems, ...prev];
        syncDatiFirebase(newLog, manualNodes);
        return newLog;
      });
    } catch (e) {
      setChatHistory(prev => { 
        const newHist = [...prev]; 
        newHist.pop(); 
        newHist.push({ sender: 'ai', text: `❌ ${e.message}` }); 
        return newHist; 
      });
    }
  };

  const generateFoodWithAI = async (foodName) => {
    const name = (foodName || foodNameInput || '').trim();
    if (!name) return;
    if (!userUid) { 
      alert('Effettua il login per salvare nuovi alimenti.'); 
      return; 
    }
    setIsGeneratingFood(true);
    try {
      const prompt = `Restituisci SOLO un JSON valido, senza altro testo, con i valori nutrizionali per 100g dell'alimento "${name}".
Chiavi obbligatorie (numeri): desc (stringa con il nome), kcal, prot, carb, fatTotal, fibre.
Aggiungi se possibile: leu, iso, val, lys, vitA, vitc, vitD, ca, fe, mg, zn, omega3 (tutti in mg o µg come standard RDA).
Esempio: {"desc":"${name}","kcal":120,"prot":25,"carb":0,"fatTotal":2,"fibre":0}`;
      const raw = await callGeminiAPIWithRotation(prompt);
      let jsonStr = raw.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();
      const data = JSON.parse(jsonStr);
      const desc = data.desc || name;
      const entryPer100 = { desc };
      ['kcal', 'cal', 'prot', 'carb', 'fatTotal', 'fibre', 'leu', 'iso', 'val', 'lys', 'vitA', 'vitc', 'vitD', 'ca', 'fe', 'mg', 'zn', 'omega3'].forEach(k => {
        if (typeof data[k] === 'number' && data[k] > 0) entryPer100[k] = data[k];
      });
      Object.keys(TARGETS).forEach(g => Object.keys(TARGETS[g]).forEach(k => {
        if (entryPer100[k] == null || entryPer100[k] === 0) entryPer100[k] = getAverageEstimate(k, desc);
      }));
      if (entryPer100.kcal == null || entryPer100.kcal === 0) entryPer100.kcal = entryPer100.cal ?? getAverageEstimate('kcal', desc);
      entryPer100.cal = entryPer100.cal ?? entryPer100.kcal;
      const newKey = `food_${Date.now()}_${desc.replace(/\s+/g, '_').slice(0, 20)}`;
      const basePath = `users/${userUid}/tracker_data`;
      await set(ref(db, `${basePath}/trackerFoodDatabase/${newKey}`), entryPer100);
      setFoodDb(prev => ({ ...prev, [newKey]: entryPer100 }));
      const weight = parseFloat(foodWeightInput) || 100;
      const ratio = weight / 100;
      const newItem = {
        id: Date.now() + Math.random(),
        type: 'food',
        mealType,
        desc,
        qta: weight,
        weight
      };
      Object.keys(entryPer100).forEach(k => {
        if (typeof entryPer100[k] === 'number' && k !== 'id') newItem[k] = entryPer100[k] * ratio;
      });
      Object.keys(TARGETS).forEach(g => Object.keys(TARGETS[g]).forEach(k => {
        if (newItem[k] == null || newItem[k] === 0) newItem[k] = (getAverageEstimate(k, desc) / 100) * weight;
      }));
      newItem.kcal = newItem.kcal ?? newItem.cal ?? (getAverageEstimate('kcal', desc) / 100) * weight;
      newItem.cal = newItem.cal ?? newItem.kcal;
      setAddedFoods(prev => [...prev, newItem]);
      setFoodNameInput('');
      setFoodWeightInput('');
      setShowFoodDropdown(false);
    } catch (e) {
      alert(`Generazione alimento fallita: ${e.message}`);
    } finally {
      setIsGeneratingFood(false);
    }
  };

  const waterProgress = Math.min((waterIntake / dailyWaterGoal) * 100, 100);
  
  const foodsLog = dailyLog.filter(item => item.type === 'food');
  const groupedFoods = foodsLog.reduce((acc, food) => {
    const slotKey = getSlotKey(food);
    if (slotKey) {
      (acc[slotKey] = acc[slotKey] || []).push(food);
    }
    return acc;
  }, {});
  
  const workoutsLog = dailyLog.filter(item => item.type === 'workout');

  const todayStr = getTodayString();

  const selectedDayData = useMemo(() => {
    if (!selectedHistoryDate || !fullStorico) return null;
    const node = fullStorico[TRACKER_STORICO_KEY(selectedHistoryDate)];
    if (!node) return null;
    const log = node.log ?? [];
    let calorie = 0, proteine = 0, workoutKcal = 0;
    (log || []).forEach(entry => {
      if (entry.type === 'meal' && entry.items) {
        entry.items.forEach(item => { 
          proteine += item.prot || 0; 
          calorie += (item.cal || item.kcal) || 0; 
        });
      } else if (entry.type === 'single' || !entry.type) {
        proteine += entry.prot || 0;
        calorie += (entry.cal || entry.kcal) || 0;
      } else if (entry.type === 'workout') {
        workoutKcal += (entry.cal || entry.kcal) || 0;
      }
    });
    const giornoSettimana = new Date(selectedHistoryDate).getDay();
    const piano = PIANO_SETTIMANALE[giornoSettimana] ?? PIANO_SETTIMANALE[1];
    const obiettivo = piano.cal + workoutKcal;
    const deficit = Math.round(calorie - obiettivo);
    return { log, calorie, proteine, workoutKcal, deficit };
  }, [fullStorico, selectedHistoryDate]);

  const pastDaysStorico = useMemo(() => {
    if (!fullStorico || typeof fullStorico !== 'object') return [];
    const keys = Object.keys(fullStorico).filter(k => k.startsWith('trackerStorico_'));
    const dates = keys.map(k => k.replace('trackerStorico_', '')).filter(d => d !== todayStr);
    dates.sort((a, b) => new Date(b) - new Date(a));
    return dates.map(dataStr => {
      const node = fullStorico[TRACKER_STORICO_KEY(dataStr)];
      const log = node?.log ?? [];
      let calorie = 0, proteine = 0, workoutKcal = 0;
      (log || []).forEach(entry => {
        if (entry.type === 'meal' && entry.items) {
          entry.items.forEach(item => { 
            proteine += item.prot || 0; 
            calorie += (item.cal || item.kcal) || 0; 
          });
        } else if (entry.type === 'single' || !entry.type) {
          proteine += entry.prot || 0;
          calorie += (entry.cal || entry.kcal) || 0;
        } else if (entry.type === 'workout') {
          workoutKcal += (entry.cal || entry.kcal) || 0;
        }
      });
      const giornoSettimana = new Date(dataStr).getDay();
      const piano = PIANO_SETTIMANALE[giornoSettimana] ?? PIANO_SETTIMANALE[1];
      const obiettivo = piano.cal + workoutKcal;
      const deficit = Math.round(calorie - obiettivo);
      return { dataStr, log, calorie, proteine, workoutKcal, deficit, note: node?.note };
    });
  }, [fullStorico, todayStr]);

  const weeklyTrendData = useMemo(() => {
    return [...pastDaysStorico].slice(0, 7).reverse().map(d => ({
      ...d,
      shortDate: d.dataStr.substring(5)
    }));
  }, [pastDaysStorico]);

  const weeklyMicrosTotals = useMemo(() => {
    const totals = { fatTotal: 0, omega3: 0, omega6: 0, vitA: 0, vitD: 0, vitE: 0, vitK: 0, vitB12: 0 };
    const last7 = pastDaysStorico.slice(0, 7);
    last7.forEach(day => {
      (day.log || []).forEach(entry => {
        const sumItem = (item) => {
          totals.fatTotal += (Number(item.fatTotal) || 0);
          totals.omega3 += (Number(item.omega3) || 0);
          totals.omega6 += (Number(item.omega6) || 0);
          totals.vitA += (Number(item.vitA) || 0);
          totals.vitD += (Number(item.vitD) || 0);
          totals.vitE += (Number(item.vitE) || 0);
          totals.vitK += (Number(item.vitK) || 0);
          totals.vitB12 += (Number(item.vitB12) || 0);
        };
        if (entry.type === 'meal' && entry.items) {
          entry.items.forEach(sumItem);
        } else if (entry.type === 'food' || entry.type === 'single' || !entry.type) {
          sumItem(entry);
        }
      });
    });
    return totals;
  }, [pastDaysStorico]);

  const getNutrientSources = (nutrientKey, target, isWeekly = false) => {
    const sources = {};
    const processEntry = (entry) => {
      const amount = Number(entry[nutrientKey]) || 0;
      if (amount > 0) {
        const name = (entry.desc || entry.name || 'Sconosciuto').trim();
        sources[name] = (sources[name] || 0) + amount;
      }
    };
    const logsToProcess = isWeekly
      ? pastDaysStorico.slice(0, 7).flatMap(d => d.log || [])
      : dailyLog;
    logsToProcess.forEach(entry => {
      if (entry.type === 'meal' && entry.items) {
        entry.items.forEach(processEntry);
      } else if (entry.type === 'food' || entry.type === 'single' || !entry.type) {
        processEntry(entry);
      }
    });
    return Object.keys(sources).map(name => {
      const amount = sources[name];
      const percent = target > 0 ? (amount / target) * 100 : 0;
      return { name, amount, percent };
    }).sort((a, b) => b.amount - a.amount);
  };

  // Renderizzatore Barre Telemetria
  const renderProgressBar = (label, current, target, unit = 'g', nutrientKey = null) => {
    const c = Number(current) ?? 0;
    const t = Number(target) ?? 0;
    const p = t > 0 ? Math.min((c / t) * 100, 100) : 0;
    const color = p >= 100 ? '#00e676' : p > 50 ? '#00e5ff' : '#ff6d00';
    return (
      <div
        style={{ marginBottom: '12px', cursor: nutrientKey ? 'pointer' : 'default', transition: 'transform 0.2s' }}
        onClick={() => nutrientKey && setNutrientModal({ label, key: nutrientKey, target: t, unit, isWeekly: false })}
        onMouseEnter={(e) => nutrientKey && (e.currentTarget.style.transform = 'scale(1.02)')}
        onMouseLeave={(e) => nutrientKey && (e.currentTarget.style.transform = 'scale(1)')}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#aaa', marginBottom: '4px' }}>
          <span>{label}</span>
          <span>{c.toFixed(1)} / {t} {unit}</span>
        </div>
        <div style={{ height: '4px', background: '#222', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{ width: `${p}%`, height: '100%', background: color, transition: 'width 0.5s' }}></div>
        </div>
      </div>
    );
  };

  const renderRatioBar = (title, labelA, valA, labelB, valB, idealText, isGood) => {
    const vA = Number(valA) || 0;
    const vB = Number(valB) || 0;
    const total = vA + vB;
    const percentA = total > 0 ? (vA / total) * 100 : 50;
    return (
      <div style={{ marginBottom: '20px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '12px', border: '1px solid #2a2a2a' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#aaa', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px' }}>
          <span>{title}</span>
          <span style={{ color: isGood ? '#00e676' : '#ffea00' }}>{idealText}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '6px', fontWeight: 'bold' }}>
          <span style={{ color: '#ff6d00' }}>{labelA}: {Math.round(vA)}</span>
          <span style={{ color: '#00e5ff' }}>{labelB}: {Math.round(vB)}</span>
        </div>
        <div style={{ height: '8px', background: '#00e5ff', borderRadius: '4px', overflow: 'hidden', display: 'flex', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)' }}>
          <div style={{ width: `${percentA}%`, background: '#ff6d00', transition: 'width 0.5s', borderRight: '2px solid #111' }}></div>
        </div>
      </div>
    );
  };

  const renderWeeklyBar = (label, current, dailyTarget, unit, nutrientKey = null) => {
    const target = (Number(dailyTarget) || 1) * 7;
    const percent = Math.min((current / target) * 100, 100);
    const isOver = current > target * 1.5;
    return (
      <div
        key={label}
        style={{ marginBottom: '10px', cursor: nutrientKey ? 'pointer' : 'default', transition: 'transform 0.2s' }}
        onClick={() => nutrientKey && setNutrientModal({ label, key: nutrientKey, target, unit, isWeekly: true })}
        onMouseEnter={(e) => nutrientKey && (e.currentTarget.style.transform = 'scale(1.02)')}
        onMouseLeave={(e) => nutrientKey && (e.currentTarget.style.transform = 'scale(1)')}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#888', marginBottom: '4px', textTransform: 'uppercase' }}>
          <span>{label}</span>
          <span style={{ color: isOver ? '#ff3d00' : '#ccc' }}>{Math.round(current)} / {Math.round(target)} {unit}</span>
        </div>
        <div style={{ height: '5px', background: '#222', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', background: isOver ? '#ff3d00' : (percent >= 100 ? '#00e676' : '#b388ff'), transition: 'width 0.5s' }}></div>
        </div>
      </div>
    );
  };

  const renderMiniBar = (label, current, target, color) => {
    const percent = Math.min((current / (target || 1)) * 100, 100);
    const isOver = current > target * 1.1;
    return (
      <div key={label} style={{ flex: '1 1 45%', minWidth: '120px', marginBottom: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#888', marginBottom: '4px' }}>
          <span>{label}</span>
          <span style={{ color: isOver ? '#ff3d00' : '#ccc' }}>{Math.round(current)} / {Math.round(target)}</span>
        </div>
        <div style={{ height: '4px', background: '#222', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', background: isOver ? '#ff3d00' : color, transition: 'width 0.3s' }}></div>
        </div>
      </div>
    );
  };

  // ========================================================
  // SCHERMATA PRINCIPALE VYTA — Curva ideale dinamica (GPS) — Hooks prima del bivio login
  // ========================================================
  const energyChartResult = generateRealEnergyData(allNodes, dailyLog || [], idealStrategy);
  const chartData = energyChartResult?.chartData ?? [];
  const realTotals = energyChartResult?.realTotals ?? {};

  const currentH = Math.floor(currentTime);
  const nextH = Math.min(24, currentH + 1);
  const fraction = currentTime - currentH;
  const dotY = chartData.length > 0
    ? (chartData[currentH]?.energy ?? 0) + ((chartData[nextH]?.energy ?? 0) - (chartData[currentH]?.energy ?? 0)) * fraction
    : 0;
  const currentMinutes = Math.round((currentTime % 1) * 60);
  const timeLabel = `ORA (${currentH.toString().padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')})`;
  const energyAt20 = chartData[20]?.energy;
  const idealDotY = chartData.length > 0
    ? (chartData[currentH]?.idealEnergy ?? 0) + ((chartData[nextH]?.idealEnergy ?? 0) - (chartData[currentH]?.idealEnergy ?? 0)) * fraction
    : 0;

  const renderData = [];
  chartData.forEach((point, index) => {
    renderData.push(point);
    if (index === currentH && fraction > 0) {
      renderData.push({
        time: currentTime,
        energy: dotY,
        idealEnergy: idealDotY
      });
    }
  });

  const renderDataWithSegments = renderData.map(d => ({
    ...d,
    energyPast: d.time <= currentTime ? d.energy : null,
    energyFuture: d.time >= currentTime ? d.energy : null
  }));

  const targetKcalChart = userTargets?.kcal ?? 2000;
  const scale = (v) => (v == null || Number.isNaN(Number(v))) ? v : (Number(v) / 100) * targetKcalChart;
  const finalChartData = chartUnit === 'kcal'
    ? renderDataWithSegments.map(d => ({
        ...d,
        energy: scale(d.energy),
        idealEnergy: scale(d.idealEnergy),
        energyPast: d.time <= currentTime ? scale(d.energy) : null,
        energyFuture: d.time >= currentTime ? scale(d.energy) : null
      }))
    : renderDataWithSegments;
  const finalDotY = chartUnit === 'kcal' ? scale(dotY) : dotY;

  const energyAt20Percent = energyAt20 ?? 50;

  const currentMealTotals = addedFoods.reduce((acc, food) => ({
    kcal: acc.kcal + (Number(food.kcal) || Number(food.cal) || 0),
    prot: acc.prot + (Number(food.prot) || 0),
    carb: acc.carb + (Number(food.carb) || 0),
    fat: acc.fat + (Number(food.fatTotal) || 0),
    fibre: acc.fibre + (Number(food.fibre) || 0)
  }), { kcal: 0, prot: 0, carb: 0, fat: 0, fibre: 0 });

  const strategyKeyForMeal = {
    merenda1: 'colazione',
    pranzo: 'pranzo',
    merenda2: 'spuntino',
    cena: 'cena',
    snack: 'spuntino'
  }[mealType] || mealType;

  const targetKcalPasto = idealStrategy[strategyKeyForMeal] || (userTargets.kcal ?? 2000) / 4;
  const dailyKcal = userTargets.kcal ?? 2000;
  const ratio = dailyKcal > 0 ? targetKcalPasto / dailyKcal : 0.25;
  const targetMacrosPasto = {
    kcal: targetKcalPasto,
    prot: (userTargets.prot ?? 150) * ratio,
    carb: (userTargets.carb ?? 200) * ratio,
    fat: (userTargets.fatTotal ?? userTargets.fat ?? 60) * ratio,
    fibre: (userTargets.fibre ?? 30) * ratio
  };

  const isReadyToDelete = draggingNode && Math.abs(dragOffsetY) > 50;

  // ========================================================
  // SCHERMATA DI LOGIN
  // ========================================================
  if (!isAuthenticated) {
    return (
      <div style={{ backgroundColor: '#000', color: '#00e5ff', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', overflow: 'hidden', position: 'relative' }}>
        <style>
          {`
            .login-box { background: rgba(10,10,10,0.9); border: 1px solid #333; padding: 40px; border-radius: 15px; z-index: 10; width: 90%; max-width: 400px; box-shadow: 0 0 40px rgba(0, 229, 255, 0.1); position: relative; }
            .login-box::before { content: ''; position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 50px; height: 2px; background: #00e5ff; box-shadow: 0 0 10px #00e5ff; }
            .sys-title { text-align: center; letter-spacing: 4px; margin-bottom: 30px; font-size: 1.2rem; }
            .login-input { width: 100%; background: #050505; border: 1px solid #333; padding: 15px; color: #fff; font-family: monospace; margin-bottom: 15px; border-radius: 5px; outline: none; transition: 0.3s; }
            .login-input:focus { border-color: #00e5ff; box-shadow: inset 0 0 10px rgba(0,229,255,0.1); }
            .login-btn { width: 100%; background: transparent; border: 1px solid #00e5ff; color: #00e5ff; padding: 15px; font-family: monospace; font-weight: bold; letter-spacing: 2px; cursor: pointer; transition: 0.3s; border-radius: 5px; margin-top: 10px; }
            .login-btn:hover { background: #00e5ff; color: #000; box-shadow: 0 0 20px rgba(0,229,255,0.4); }
            .spinner { border: 2px solid transparent; border-top-color: #00e5ff; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto 20px auto; }
            @keyframes spin { to { transform: rotate(360deg); } }
          `}
        </style>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'radial-gradient(circle at center, #050505 0%, #000 100%)', opacity: 0.8, pointerEvents: 'none' }}></div>
        {isBooting ? (
          <div className="login-box" style={{textAlign: 'center', color: '#fff', fontSize: '0.8rem', lineHeight: '1.8'}}>
            <div className="spinner"></div>
            <div>VERIFICA CREDENZIALI...</div>
            <div style={{color: '#888'}}>CONNESSIONE CLOUD [OK]</div>
            <div style={{color: '#00e676', marginTop: '10px'}}>ACCESSO CONSENTITO</div>
          </div>
        ) : (
          <form className="login-box" onSubmit={handleLogin}>
            <div className="sys-title">VYTA <span style={{color: '#444'}}>// V7</span></div>
            <p style={{textAlign: 'center', fontSize: '0.65rem', color: '#666', marginBottom: '20px'}}>SYSTEM ENCRYPTED. REQUIRE AUTHENTICATION.</p>
            <input type="email" placeholder="USER ID (EMAIL)" className="login-input" required value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
            <input type="password" placeholder="PASSWORD" className="login-input" required value={loginPassword} onChange={e => setLoginPassword(e.target.value)} />
            <button type="submit" className="login-btn">INIZIALIZZA</button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#000', color: '#fff', minHeight: '100vh', display: 'flex', flexDirection: 'column', padding: '20px', fontFamily: 'sans-serif', overflow: 'hidden' }}>
      
      <style>
        {`
          .future { stroke-dasharray: 4 6; animation: f-flow 2s linear infinite; opacity: 0.2; }
          @keyframes f-flow { from { stroke-dashoffset: 20; } to { stroke-dashoffset: 0; } }

          .btn-toggle { background: none; border: 1px solid #333; color: #666; padding: 8px 16px; border-radius: 20px; font-size: 0.7rem; cursor: pointer; letter-spacing: 2px; transition: all 0.3s; }
          .btn-toggle.active { border-color: #00e5ff; color: #00e5ff; box-shadow: 0 0 10px rgba(0,229,255,0.2); }
          
          .drawer-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(8px); opacity: 0; pointer-events: none; transition: opacity 0.4s ease; z-index: 100; }
          .drawer-overlay.open { opacity: 1; pointer-events: all; }
          
          .drawer-content { position: fixed; bottom: -100%; left: 0; right: 0; background: rgba(15, 15, 15, 0.95); border-top: 1px solid #2a2a2a; border-radius: 35px 35px 0 0; padding: 40px 25px; transition: bottom 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.05); z-index: 101; box-shadow: 0 -10px 50px rgba(0,0,0,0.9); max-height: 88vh; overflow-y: auto; backdrop-filter: blur(25px); }
          .drawer-content.open { bottom: 0; }
          
          @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
          .view-animate { animation: fadeIn 0.3s ease forwards; }

          .action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .action-btn { background: rgba(255,255,255,0.04); border: 1px solid #2a2a2a; color: #fff; padding: 15px; border-radius: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; cursor: pointer; transition: 0.2s; }
          .action-btn:active { transform: scale(0.95); border-color: #555; background: rgba(255,255,255,0.08); }
          .action-btn.full-width { grid-column: 1 / -1; flex-direction: row; padding: 20px; gap: 15px; }
          .action-btn.full-width .action-icon { font-size: 2rem; }
          .action-icon { font-size: 1.6rem; filter: drop-shadow(0 0 5px rgba(255,255,255,0.1)); }
          .action-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 1.5px; color: #aaa; font-weight: 600; }

          .type-btn { flex: 1; background: transparent; border: 1px solid #333; color: #777; padding: 12px 0; border-radius: 14px; font-size: 0.7rem; letter-spacing: 1px; cursor: pointer; transition: 0.3s; text-align: center; }
          .type-btn.active { background: #fff; color: #000; border-color: #fff; font-weight: bold; box-shadow: 0 0 15px rgba(255,255,255,0.2); }
          .type-btn.active.orange { background: #ff6d00; color: #000; border-color: #ff6d00; box-shadow: 0 0 15px rgba(255, 109, 0, 0.4); }
          .type-btn.active.blue { background: #00e5ff; color: #000; border-color: #00e5ff; box-shadow: 0 0 15px rgba(0, 229, 255, 0.4); }

          .burn-slider-container { background: #111; padding: 30px 20px; border-radius: 20px; border: 1px solid #222; text-align: center; margin-bottom: 20px; position: relative; overflow: hidden; }
          .burn-value { font-size: 3.5rem; font-weight: bold; color: #fff; line-height: 1; margin-bottom: 5px; }
          .burn-value.tuning { color: #00e5ff; text-shadow: 0 0 20px rgba(0,229,255,0.3); }
          .burn-value.workout { color: #ff6d00; text-shadow: 0 0 20px rgba(255,109,0,0.3); }
          .burn-label { font-size: 0.75rem; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 25px; display: block; }
          .custom-range { -webkit-appearance: none; width: 100%; height: 8px; border-radius: 4px; background: #2a2a2a; outline: none; position: relative; z-index: 2; }
          .custom-range.orange::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 26px; height: 26px; border-radius: 50%; background: #ff6d00; cursor: pointer; box-shadow: 0 0 15px #ff6d00, inset 0 0 5px rgba(255,255,255,0.8); border: 2px solid #fff; }
          .custom-range.blue::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 26px; height: 26px; border-radius: 50%; background: #00e5ff; cursor: pointer; box-shadow: 0 0 15px #00e5ff, inset 0 0 5px rgba(255,255,255,0.8); border: 2px solid #fff; }

          .food-pill { display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.5); border: 1px solid #2a2a2a; padding: 12px 15px; border-radius: 14px; margin-bottom: 8px; animation: fadeIn 0.2s ease; }
          .food-pill-name { font-size: 0.85rem; font-weight: 500; color: #eee; }
          .food-pill-weight { font-size: 0.75rem; color: #00e5ff; margin-left: 10px; font-weight: bold; }
          .food-pill-actions { display: flex; gap: 10px; align-items: center; }
          .food-pill-btn { background: none; border: none; cursor: pointer; font-size: 1rem; opacity: 0.6; transition: 0.2s; padding: 0; }
          .food-pill-btn:hover { opacity: 1; }
          .btn-info { color: #fff; } .btn-delete { color: #ff4d4d; }
          .quick-add-bar { display: flex; background: rgba(255,255,255,0.05); border-radius: 18px; border: 1px solid #333; overflow: hidden; margin-bottom: 20px; transition: border-color 0.3s; }
          .quick-add-bar:focus-within { border-color: #00e5ff; box-shadow: 0 0 15px rgba(0, 229, 255, 0.1); }
          .quick-input { background: transparent; border: none; color: #fff; padding: 16px; font-size: 0.9rem; outline: none; }
          .input-name { flex: 2; border-right: 1px solid #333; }
          .input-weight { flex: 1; text-align: center; }
          .quick-add-btn { background: #00e5ff; color: #000; border: none; padding: 0 20px; font-weight: bold; font-size: 1.2rem; cursor: pointer; transition: 0.2s; }
          
          .diary-group-title { font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 2px; margin: 20px 0 10px 10px; border-left: 2px solid #00e5ff; padding-left: 10px; }
          
          .water-fill-container { height: 12px; background: #222; border-radius: 6px; overflow: hidden; margin: 20px 0 40px 0; position: relative; box-shadow: inset 0 2px 5px rgba(0,0,0,0.5); }
          .water-fill-bar { height: 100%; background: linear-gradient(90deg, #007aff, #00e5ff); border-radius: 6px; transition: width 0.8s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 0 15px rgba(0, 229, 255, 0.6); position: relative; }
          .water-quick-btn { background: rgba(0, 229, 255, 0.05); border: 1px solid rgba(0, 229, 255, 0.2); color: #00e5ff; padding: 25px 0; border-radius: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; cursor: pointer; transition: 0.2s; flex: 1; }
          .water-rectify-btn { background: transparent; border: 1px solid #333; color: #888; border-radius: 12px; padding: 8px 15px; font-size: 0.75rem; cursor: pointer; transition: 0.2s; }
          
          .chat-container { display: flex; flex-direction: column; height: 380px; }
          .chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; padding-right: 5px; padding-bottom: 20px; }
          .chat-bubble { max-width: 82%; padding: 14px 18px; border-radius: 20px; font-size: 0.9rem; line-height: 1.4; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
          .bubble-ai { background: #1f1f1f; border: 1px solid #333; color: #eee; border-bottom-left-radius: 4px; align-self: flex-start; }
          .bubble-user { background: linear-gradient(135deg, #00e5ff, #007aff); color: #000; font-weight: 500; border-bottom-right-radius: 4px; align-self: flex-end; }
          .typing-indicator { display: flex; gap: 4px; padding: 5px; }
          .dot { width: 6px; height: 6px; background: #888; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
          .dot:nth-child(1) { animation-delay: -0.32s; } .dot:nth-child(2) { animation-delay: -0.16s; }
          @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); background: #fff; } }
          .chat-input-wrapper { display: flex; align-items: center; gap: 10px; background: #1a1a1a; border-radius: 30px; padding: 6px 6px 6px 20px; border: 1px solid #333; margin-top: 10px; }
          .chat-input { flex: 1; background: transparent; border: none; color: #fff; font-size: 0.95rem; outline: none; }
          .chat-send-btn { background: #fff; color: #000; border: none; width: 40px; height: 40px; border-radius: 50%; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: 0.2s; font-size: 1.1rem; }
          .chat-send-btn.has-text { background: #b388ff; color: #fff; }

          .zen-container { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 250px; position: relative; margin-bottom: 20px; }
          .zen-orb { width: 80px; height: 80px; border-radius: 50%; background: radial-gradient(circle, #fbc02d 10%, #f57f17 100%); opacity: 0.2; box-shadow: 0 0 20px rgba(251, 192, 45, 0.2); transition: all 0.5s ease; position: relative; z-index: 2; }
          .zen-orb.breathing { animation: boxBreathe 16s linear infinite; }
          @keyframes boxBreathe { 0% { transform: scale(1); opacity: 0.3; box-shadow: 0 0 20px rgba(251, 192, 45, 0.2); } 25% { transform: scale(2.2); opacity: 1; box-shadow: 0 0 80px rgba(251, 192, 45, 0.8); } 50% { transform: scale(2.2); opacity: 1; box-shadow: 0 0 80px rgba(251, 192, 45, 0.8); } 75% { transform: scale(1); opacity: 0.3; box-shadow: 0 0 20px rgba(251, 192, 45, 0.2); } 100% { transform: scale(1); opacity: 0.3; box-shadow: 0 0 20px rgba(251, 192, 45, 0.2); } }
          .zen-rings { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 80px; height: 80px; border-radius: 50%; border: 1px solid rgba(251, 192, 45, 0.3); z-index: 1; transition: all 0.5s ease; }
          .breathing ~ .zen-rings { animation: ringsExpand 16s linear infinite; }
          @keyframes ringsExpand { 0% { transform: translate(-50%, -50%) scale(1); opacity: 0; } 12% { opacity: 1; } 25% { transform: translate(-50%, -50%) scale(2.6); opacity: 0; } 100% { transform: translate(-50%, -50%) scale(2.6); opacity: 0; } }
          .zen-instruction { position: absolute; bottom: 0; font-size: 0.8rem; color: #888; letter-spacing: 2px; text-transform: uppercase; animation: fadeInOut 16s linear infinite; opacity: 0; }
          .breathing ~ .zen-instruction { opacity: 1; }
          @keyframes fadeInOut { 0%, 24% { content: "Inspira"; color: #fbc02d; } 25%, 49% { content: "Trattieni"; color: #fff; } 50%, 74% { content: "Espira"; color: #fbc02d; } 75%, 100% { content: "Pausa"; color: #888; } }

          .delete-overlay { position: fixed; inset: 0; background: radial-gradient(circle, rgba(220, 38, 38, 0.0) 40%, rgba(220, 38, 38, 0.25) 100%); z-index: 45; pointer-events: none; opacity: 0; transition: opacity 0.2s ease; display: flex; align-items: center; justify-content: center; flex-direction: column; }
          .delete-overlay.active { opacity: 1; }
          .delete-icon { font-size: 5rem; filter: drop-shadow(0 0 20px rgba(220, 38, 38, 0.8)); opacity: 0.5; transform: scale(0.8); transition: transform 0.2s ease; }
          .delete-overlay.active .delete-icon { transform: scale(1); opacity: 0.8; }
          .delete-text { color: #ef4444; font-size: 1.2rem; letter-spacing: 4px; font-weight: bold; margin-top: 20px; text-shadow: 0 0 10px rgba(220, 38, 38, 0.5); }

          @media print {
            body * { visibility: hidden; }
            .report-modal-overlay, .report-modal-overlay * { visibility: visible; }
            .report-modal-overlay { position: absolute; left: 0; top: 0; padding: 0; background: white; }
            .report-no-print { display: none !important; }
          }
        `}
      </style>

      <div className={`delete-overlay ${isReadyToDelete ? 'active' : ''}`}>
        <div className="delete-icon">🗑️</div>
        <div className="delete-text">RILASCIA PER ELIMINARE</div>
      </div>

      {/* HEADER E GRAFICO */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
        <h1 style={{ fontSize: '1rem', letterSpacing: '4px', margin: 0 }}>VYTA <span style={{color: '#444'}}>SYS</span></h1>
        <button type="button" className="btn-toggle" onClick={() => setShowTelemetryPopup(true)} style={{ background: 'rgba(0, 230, 118, 0.15)', borderColor: '#00e676', color: '#00e676' }}>📊 STATS</button>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className={`btn-toggle ${showDetails ? 'active' : ''}`} onClick={() => setShowDetails(!showDetails)}>HUD: {showDetails ? 'ON' : 'OFF'}</button>
          <button className="btn-toggle" onClick={() => { auth.signOut(); }}>LOGOUT</button>
        </div>
      </div>

      {/* Navigazione storica (Time-Travel) */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px', marginBottom: '20px', background: '#111', padding: '10px', borderRadius: '12px' }}>
        <button type="button" onClick={() => changeDate(-1)} style={{ background: '#333', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>◀ Ieri</button>
        <h2 style={{ color: '#fff', margin: 0, fontSize: '1.2rem' }}>
          {currentDateObj.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}
        </h2>
        <button type="button" onClick={() => changeDate(1)} disabled={currentTrackerDate === getTodayString()} style={{ background: currentTrackerDate === getTodayString() ? '#111' : '#333', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '8px', cursor: currentTrackerDate === getTodayString() ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: currentTrackerDate === getTodayString() ? 0.5 : 1 }}>Domani ▶</button>
      </div>

      {/* Cruscotto energetico giornaliero 0-24h */}
      <div style={{ marginBottom: '24px', background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: '16px', padding: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ fontSize: '0.7rem', color: '#666', letterSpacing: '2px', textTransform: 'uppercase' }}>Energia 0–24h</span>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button type="button" onClick={() => setChartUnit('percent')} style={{ padding: '4px 10px', fontSize: '0.7rem', borderRadius: '8px', border: '1px solid #333', background: chartUnit === 'percent' ? 'rgba(0, 229, 255, 0.2)' : 'transparent', color: chartUnit === 'percent' ? '#00e5ff' : '#666', cursor: 'pointer', fontWeight: chartUnit === 'percent' ? 'bold' : 'normal' }}>%</button>
            <button type="button" onClick={() => setChartUnit('kcal')} style={{ padding: '4px 10px', fontSize: '0.7rem', borderRadius: '8px', border: '1px solid #333', background: chartUnit === 'kcal' ? 'rgba(0, 229, 255, 0.2)' : 'transparent', color: chartUnit === 'kcal' ? '#00e5ff' : '#666', cursor: 'pointer', fontWeight: chartUnit === 'kcal' ? 'bold' : 'normal' }}>Kcal</button>
          </div>
        </div>
        <div style={{ position: 'relative', overflow: 'visible' }}>
          <ResponsiveContainer width="100%" height={250}>
            <ComposedChart data={finalChartData} margin={{ top: 35, right: 20, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorEnergy" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00b4d8" stopOpacity={0.9} />
                  <stop offset="50%" stopColor="#047857" stopOpacity={0.7} />
                  <stop offset="100%" stopColor="#dc2626" stopOpacity={0.6} />
                </linearGradient>
                <linearGradient id="vitalFlow" x1="0" y1="0" x2="1" y2="0">
                  <animate attributeName="x1" values="-0.3;1.3;-0.3" dur="4s" repeatCount="indefinite" />
                  <animate attributeName="x2" values="0.7;2.3;0.7" dur="4s" repeatCount="indefinite" />
                  <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.8" />
                  <stop offset="50%" stopColor="#b388ff" stopOpacity="1" />
                  <stop offset="100%" stopColor="#00e5ff" stopOpacity="0.8" />
                </linearGradient>
                <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <XAxis dataKey="time" type="number" domain={[0, 24]} tickCount={13} tickFormatter={(val) => `${Math.floor(val)}:00`} axisLine={false} tickLine={false} tick={{ fill: '#666', fontSize: 10 }} />
              <YAxis domain={chartUnit === 'kcal' ? [0, targetKcalChart] : [0, 100]} tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} width={40} tickFormatter={(val) => chartUnit === 'kcal' ? Math.round(Number(val)) : `${val}%`} />
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
              <Tooltip labelFormatter={(label) => `${Math.floor(Number(label))}:00`} formatter={(value) => (value != null && !Number.isNaN(Number(value))) ? (chartUnit === 'kcal' ? `${Math.round(Number(value))} kcal` : `${value}%`) : ''} contentStyle={{ backgroundColor: '#111', border: '1px solid #333', borderRadius: '8px', fontSize: '0.8rem' }} />
              <Area type="monotone" dataKey="energyPast" stroke="url(#vitalFlow)" strokeWidth={3} fill="url(#colorEnergy)" filter="url(#glow)" isAnimationActive={!draggingNode} animationDuration={600} animationEasing="ease-in-out" connectNulls={false} />
              <Area type="monotone" dataKey="energyFuture" stroke="#333" strokeWidth={2} strokeDasharray="5 5" fill="transparent" isAnimationActive={!draggingNode} animationDuration={600} animationEasing="ease-in-out" connectNulls={false} className="future" />
              <Line type="monotone" dataKey="idealEnergy" stroke="rgba(255, 255, 255, 0.6)" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={!draggingNode} animationDuration={600} animationEasing="ease-in-out" />
              <ReferenceLine x={currentTime} stroke="rgba(255,255,255,0.3)" strokeDasharray="3 3" isFront label={{ position: 'top', value: timeLabel, fill: '#aaa', fontSize: 11, offset: 10 }} />
              <ReferenceDot x={currentTime} y={finalDotY} isFront shape={(props) => {
                const cx = props?.cx;
                const cy = props?.cy;
                if (cx == null || cy == null || typeof cx !== 'number' || typeof cy !== 'number') return <path d="M0 0" />;
                return (
                  <g>
                    <circle cx={cx} cy={cy} r={5} fill="#00e5ff" />
                    <circle cx={cx} cy={cy} r={5} fill="none" stroke="#00e5ff" strokeWidth={2}>
                      <animate attributeName="r" values="5;18" dur="1.2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.9;0" dur="1.2s" repeatCount="indefinite" />
                    </circle>
                    <circle cx={cx} cy={cy} r={8} fill="none" stroke="#b388ff" strokeWidth={1.5} opacity={0.7}>
                      <animate attributeName="r" values="8;24" dur="2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0" dur="2s" repeatCount="indefinite" />
                    </circle>
                  </g>
                );
              }} />
            </ComposedChart>
          </ResponsiveContainer>
              <div ref={timelineContainerRef} style={{ position: 'relative', height: '44px', marginTop: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid #222', overflow: 'visible' }}>
                  {allNodes.map((node) => {
                    const isWork = node.type === 'work';
                    const startPercent = (node.time / 24) * 100;
                    const durationPercent = isWork ? ((node.duration || 1) / 24) * 100 : 0;
                    const idealVal = node.type === 'meal' ? (idealStrategy[node.strategyKey] ?? 400) : (node.type === 'workout' ? (idealStrategy.allenamento ?? 300) : (node.kcal ?? 400));
                    const realVal = (node.type === 'meal' || node.type === 'workout') ? (realTotals[node.strategyKey] ?? 0) : 0;
                    const ratio = idealVal > 0 ? realVal / idealVal : 1;
                    let borderColor = '#00e5ff';
                    if (ratio < 0.5) borderColor = '#ff3d00';
                    else if (ratio > 1.2) borderColor = '#ffea00';
                    const pointBorderColor = isWork ? '#ffea00' : borderColor;
                    const isDragging = draggingNode?.id === node.id;
                    const dragY = isDragging ? dragOffsetY : 0;

                    if (isWork) {
                      const dragEdge = isDragging ? draggingNode?.edge : null;
                      return (
                        <div key={node.id} onPointerDown={(e) => startLongPress(node, 'all', e)} style={{ position: 'absolute', left: `${startPercent}%`, width: `${durationPercent}%`, top: '50%', marginTop: '-18px', height: '36px', transform: isDragging ? `translateY(${dragY}px)` : undefined, background: isDragging ? 'rgba(255, 234, 0, 0.3)' : 'rgba(255, 234, 0, 0.15)', borderLeft: '2px solid #ffea00', borderRight: '2px solid #ffea00', borderRadius: '4px', cursor: isDragging ? 'grabbing' : 'pointer', zIndex: isDragging ? 50 : 5, transition: isDragging ? 'none' : 'background 0.15s' }}>
                          <div onPointerDown={(e) => startLongPress(node, 'start', e)} style={{ position: 'absolute', left: '-18px', width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(0,0,0,0.8)', border: '2px solid #ffea00', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'ew-resize' }}>
                            {(dragEdge === 'start' || dragEdge === 'all') && (
                              <div style={{ position: 'absolute', top: '-28px', left: '50%', transform: 'translateX(-50%)', background: '#ffea00', color: '#000', padding: '2px 6px', borderRadius: '6px', fontSize: '0.65rem', fontWeight: 'bold', zIndex: 60, whiteSpace: 'nowrap', boxShadow: '0 2px 5px rgba(0,0,0,0.5)' }}>
                                {Math.floor(node.time)}:{String(Math.round((node.time % 1) * 60)).padStart(2, '0')}
                              </div>
                            )}
                            💼
                          </div>
                          <div onPointerDown={(e) => startLongPress(node, 'end', e)} style={{ position: 'absolute', right: '-18px', width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(0,0,0,0.8)', border: '2px solid #ffea00', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'ew-resize' }}>
                            {(dragEdge === 'end' || dragEdge === 'all') && (
                              <div style={{ position: 'absolute', top: '-28px', left: '50%', transform: 'translateX(-50%)', background: '#ffea00', color: '#000', padding: '2px 6px', borderRadius: '6px', fontSize: '0.65rem', fontWeight: 'bold', zIndex: 60, whiteSpace: 'nowrap', boxShadow: '0 2px 5px rgba(0,0,0,0.5)' }}>
                                {Math.floor(node.time + (node.duration || 1))}:{String(Math.round(((node.time + (node.duration || 1)) % 1) * 60)).padStart(2, '0')}
                              </div>
                            )}
                            🏁
                          </div>
                        </div>
                      );
                    }

                    const isPesi = node.type === 'workout' && node.subType === 'pesi' && node.muscles?.length > 0;
                    const iconContent = isPesi ? node.muscles.map(m => m.substring(0, 2).toUpperCase()).join('+') : (node.icon || '•');
                    return (
                      <div key={node.id} onPointerDown={(e) => startLongPress(node, 'all', e)} style={{ position: 'absolute', left: `${startPercent}%`, transform: isDragging ? `translate(-50%, ${dragY}px) scale(2)` : 'translateX(-50%)', top: '50%', marginTop: '-18px', width: '36px', height: '36px', borderRadius: '50%', background: isDragging ? 'rgba(0,229,255,0.35)' : 'rgba(0,0,0,0.6)', border: `2px solid ${pointBorderColor}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: isDragging ? 'grabbing' : 'pointer', zIndex: isDragging ? 50 : 10, transition: isDragging ? 'none' : 'transform 0.15s, background 0.15s' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: 'bold', color: pointBorderColor, marginBottom: '2px', transition: 'color 0.2s' }}>
                          {Math.floor(node.time)}:{String(Math.round((node.time % 1) * 60)).padStart(2, '0')}
                        </span>
                        <span style={{ lineHeight: 1, fontSize: isPesi ? '0.55rem' : '1rem', fontWeight: isPesi ? 'bold' : 'normal', color: isPesi ? pointBorderColor : 'inherit' }}>{iconContent}</span>
                      </div>
                    );
                  })}
                  <button type="button" onClick={(e) => { e.stopPropagation(); setShowChoiceModal(true); }} style={{ position: 'absolute', top: '4px', right: '8px', width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(0,229,255,0.2)', border: '1px solid #00e5ff', color: '#00e5ff', fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }} title="Aggiungi nodo">+</button>
                </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px', padding: '10px', flexWrap: 'wrap' }}>
              {(Number(totali?.omega3) ?? 0) < 1 ? (
                <span style={{ background: '#440000', color: '#ff5555', borderRadius: 20, padding: '5px 10px', fontSize: '0.8rem' }}>🔴 Carenza Omega3</span>
              ) : (
                <span style={{ background: '#003300', color: '#55ff55', borderRadius: 20, padding: '5px 10px', fontSize: '0.8rem' }}>🟢 Micro OK</span>
              )}
              {energyAt20Percent < 40 ? (
                <span style={{ background: '#440000', color: '#ff5555', borderRadius: 20, padding: '5px 10px', fontSize: '0.8rem' }}>🚨 Rischio Cortisolo (Cena)</span>
              ) : (
                <span style={{ background: '#003300', color: '#55ff55', borderRadius: 20, padding: '5px 10px', fontSize: '0.8rem' }}>🟢 Livelli Serali OK</span>
              )}
            </div>
        </div>
      <div style={{ textAlign: 'center', marginTop: '24px' }}>
        <button onClick={openDrawer} style={{ width: '65px', height: '65px', borderRadius: '50%', backgroundColor: '#fff', border: 'none', color: '#000', fontSize: '28px', cursor: 'pointer', boxShadow: '0 0 20px rgba(255,255,255,0.2)', transition: 'transform 0.1s' }} onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.9)'} onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}>+</button>
      </div>

      {/* --- CASSETTO AZIONI --- */}
      <div className={`drawer-overlay ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      
      <div className={`drawer-content ${isDrawerOpen ? 'open' : ''}`}>
        <div style={{ width: '40px', height: '4px', backgroundColor: '#444', borderRadius: '2px', margin: '0 auto 20px auto' }}></div>
        
        {/* VISTA MENU PRINCIPALE */}
        {!activeAction && (
          <div className="view-animate">
            <h2 style={{ fontSize: '0.7rem', textAlign: 'center', color: '#777', letterSpacing: '3px', marginBottom: '25px', fontWeight: 'normal' }}>MENU SISTEMA</h2>
            <div className="action-grid">
              <button className="action-btn" onClick={() => { setAddedFoods([]); setEditingMealId(null); const t = getDefaultMealTime(mealType); setDrawerMealTime(t); setDrawerMealTimeStr(decimalToTimeStr(t)); setActiveAction('pasto'); setIsDrawerOpen(true); }}><span className="action-icon">🍽️</span><span className="action-label">Pasto</span></button>
              <button className="action-btn" onClick={() => setActiveAction('acqua')}><span className="action-icon" style={{ filter: 'drop-shadow(0 0 8px rgba(0, 229, 255, 0.4))' }}>💧</span><span className="action-label" style={{ color: '#00e5ff' }}>Acqua</span></button>
              <button className="action-btn" onClick={() => setActiveAction('allenamento')}><span className="action-icon" style={{ filter: 'drop-shadow(0 0 8px rgba(255, 109, 0, 0.4))' }}>⚡</span><span className="action-label" style={{ color: '#ff6d00' }}>Attività</span></button>
              <button className="action-btn" onClick={() => setActiveAction('diario_giornaliero')}><span className="action-icon" style={{ filter: 'drop-shadow(0 0 8px rgba(0, 230, 118, 0.4))' }}>📓</span><span className="action-label" style={{ color: '#00e676' }}>Diario Giornaliero</span></button>
              <button className="action-btn" onClick={() => setActiveAction('storico')}><span className="action-icon" style={{ filter: 'drop-shadow(0 0 8px rgba(176, 190, 197, 0.5))' }}>📚</span><span className="action-label" style={{ color: '#b0bec5' }}>Archivio Storico</span></button>
              <button className="action-btn" onClick={() => setShowReport(true)}><span className="action-icon">📊</span><span className="action-label">Report</span></button>
              <button className="action-btn" onClick={() => setShowProfile(true)}><span className="action-icon">⚙️</span><span className="action-label">Profilo & Target</span></button>
              <button className="action-btn" onClick={() => setActiveAction('strategia')}><span className="action-icon" style={{ filter: 'drop-shadow(0 0 8px rgba(0, 229, 255, 0.4))' }}>🎯</span><span className="action-label" style={{ color: '#00e5ff' }}>Protocollo</span></button>
              <button className="action-btn" onClick={() => setActiveAction('focus')}><span className="action-icon" style={{ filter: 'drop-shadow(0 0 8px rgba(251, 192, 45, 0.4))' }}>🧘</span><span className="action-label" style={{ color: '#fbc02d' }}>Neural Reset</span></button>
              <button className="action-btn full-width" onClick={() => setActiveAction('ai_chat')} style={{ background: 'linear-gradient(145deg, rgba(26, 26, 36, 0.9), rgba(18, 16, 28, 0.9))', borderColor: '#3a2a4a' }}>
                <span className="action-icon" style={{ filter: 'drop-shadow(0 0 10px rgba(179, 136, 255, 0.5))' }}>✨</span><span className="action-label" style={{ color: '#b388ff' }}>Assistente AI</span>
              </button>
            </div>
            <div style={{ padding: '15px', background: '#1e1e1e', borderRadius: '12px', marginTop: '20px' }}>
              <h4 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '0.8rem' }}>⚡ Inserimento Rapido / Output AI</h4>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  type="text"
                  id="fast-ai-input"
                  placeholder="Es: [Pollo | 150 | pranzo] oppure incolla qui la risposta AI"
                  style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #444', background: '#000', color: '#fff', fontSize: '0.85rem' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      processTestoAI(e.target.value);
                      e.target.value = '';
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const input = document.getElementById('fast-ai-input');
                    if (input) {
                      processTestoAI(input.value);
                      input.value = '';
                    }
                  }}
                  style={{ background: '#00e5ff', color: '#000', border: 'none', padding: '0 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  Invia
                </button>
              </div>
            </div>
          </div>
        )}

        {/* VISTA STRATEGIA */}
        {activeAction === 'strategia' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; MENU</button>
              <h2 style={{ fontSize: '0.8rem', color: '#00e5ff', letterSpacing: '2px', margin: 0 }}>🎯 PROTOCOLLO</h2>
              <div style={{ width: '60px' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '25px' }}>
              {Object.keys(STRATEGY_PROFILES).map(key => (
                <button key={key} className={`type-btn ${dayProfile === key ? 'active blue' : ''}`} onClick={() => setDayProfile(key)}>
                  {STRATEGY_PROFILES[key].label}
                </button>
              ))}
            </div>
            <div className="burn-slider-container">
              <span className="burn-label" style={{color: '#00e5ff'}}>TUNING CALORICO (OVERRIDE)</span>
              <div className="burn-value tuning">{calorieTuning > 0 ? `+${calorieTuning}` : calorieTuning}</div>
              <input type="range" min="-500" max="500" step="50" value={calorieTuning} onChange={(e) => setCalorieTuning(Number(e.target.value))} className="custom-range blue" style={{ marginTop: '20px' }} />
            </div>
            <button onClick={() => closeDrawer()} style={{ width: '100%', padding: '18px', backgroundColor: '#00e5ff', color: '#000', border: 'none', borderRadius: '15px', fontSize: '0.9rem', fontWeight: 'bold', letterSpacing: '2px', cursor: 'pointer', transition: '0.2s', boxShadow: '0 0 20px rgba(0, 229, 255, 0.4)' }}>SYNC STRATEGIA</button>
          </div>
        )}

        {/* VISTA CHAT AI */}
        {activeAction === 'ai_chat' && (
          <div className="view-animate" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#888', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; MENU</button>
              <h2 style={{ fontSize: '0.8rem', color: '#b388ff', letterSpacing: '2px', margin: 0 }}>✨ ASSISTENTE AI</h2>
              <button onClick={() => setShowAiSettings(!showAiSettings)} style={{ background: 'none', border: 'none', color: '#b388ff', fontSize: '1.2rem', cursor: 'pointer', filter: 'drop-shadow(0 0 5px rgba(179, 136, 255, 0.5))' }}>⚙️</button>
            </div>

            {showAiSettings && (
              <div style={{ background: '#111', padding: '20px', borderRadius: '15px', marginBottom: '15px', border: '1px solid #333' }}>
                <h4 style={{ fontSize: '0.7rem', color: '#b388ff', margin: '0 0 10px 0', letterSpacing: '1px' }}>CLUSTER NODI API (FALLBACK)</h4>
                {apiKeys.map((key, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{color: '#555', fontSize: '0.7rem'}}>N.{idx+1}</span>
                    <input type="password" value={key} onChange={(e) => handleKeyChange(idx, e.target.value)} style={{ flex: 1, background: '#222', border: '1px solid #444', color: '#fff', padding: '8px', borderRadius: '6px', fontSize: '0.8rem' }} placeholder="Incolla chiave Gemini..." />
                    <button onClick={() => handleRemoveKey(idx)} style={{ background: 'none', border: 'none', color: '#ff4d4d', cursor: 'pointer', padding: '5px' }}>✕</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                  <button onClick={handleAddKey} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px dashed #333', color: '#aaa', borderRadius: '8px', cursor: 'pointer' }}>+ Aggiungi Nodo</button>
                  <button onClick={saveApiCluster} style={{ flex: 1, padding: '10px', background: '#b388ff', border: 'none', color: '#000', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Salva Rete</button>
                </div>
              </div>
            )}

            <div className="chat-container">
              <div className="chat-messages">
                {chatHistory.map((msg, idx) => (
                  <div key={idx} className={`chat-bubble ${msg.sender === 'ai' ? 'bubble-ai' : 'bubble-user'}`}>
                    {msg.isTyping ? (<div className="typing-indicator"><div className="dot"></div><div className="dot"></div><div className="dot"></div></div>) : (msg.text)}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="chat-input-wrapper">
                <input type="text" className="chat-input" placeholder="Es: Ho mangiato 200g pollo..." value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleChatSubmit()} autoFocus />
                <button className={`chat-send-btn ${chatInput.trim() ? 'has-text' : ''}`} onClick={handleChatSubmit}>↑</button>
              </div>
            </div>
          </div>
        )}

        {/* VISTA ACQUA */}
        {activeAction === 'acqua' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; INDIETRO</button>
              <h2 style={{ fontSize: '0.8rem', color: '#00e5ff', letterSpacing: '2px', margin: 0 }}>💧 IDRATAZIONE</h2>
              <div style={{ width: '70px' }}></div>
            </div>
            <div style={{ textAlign: 'center', marginTop: '10px' }}>
              <h3 style={{ fontSize: '3rem', margin: '0', color: '#fff', fontWeight: 'bold' }}>{waterIntake} <span style={{ fontSize: '1rem', color: '#666', fontWeight: 'normal' }}>/ {dailyWaterGoal} ml</span></h3>
              <div className="water-fill-container"><div className="water-fill-bar" style={{ width: `${waterProgress}%` }}></div></div>
            </div>
            <div style={{ display: 'flex', gap: '15px' }}>
              <button onClick={() => handleAddWater(250)} className="water-quick-btn"><span style={{ fontSize: '1.8rem', marginBottom: '5px' }}>🥛</span><span style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>+ 250ml</span></button>
              <button onClick={() => handleAddWater(500)} className="water-quick-btn"><span style={{ fontSize: '1.8rem', marginBottom: '5px' }}>🚰</span><span style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>+ 500ml</span></button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginTop: '20px' }}>
              <button onClick={() => handleAddWater(-250)} className="water-rectify-btn">- 250</button>
              <button onClick={() => handleAddWater(-500)} className="water-rectify-btn">- 500</button>
              <button onClick={() => setWaterIntake(0)} className="water-rectify-btn" style={{ borderColor: 'rgba(255, 77, 77, 0.4)', color: '#ff4d4d' }}>Azzera</button>
            </div>
          </div>
        )}
        
        {/* VISTA ALLENAMENTO */}
        {activeAction === 'allenamento' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; INDIETRO</button>
              <h2 style={{ fontSize: '0.8rem', color: '#ff6d00', letterSpacing: '2px', margin: 0 }}>⚡ ATTIVITÀ</h2>
              <div style={{ width: '70px' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '30px' }}>
              {['pesi', 'cardio', 'hiit', 'lavoro'].map(type => (
                <button key={type} className={`type-btn ${workoutType === type ? 'active orange' : ''}`} onClick={() => setWorkoutType(type)}>
                  {type === 'pesi' ? '🏋️ PESI' : type === 'cardio' ? '🏃 CARDIO' : type === 'hiit' ? '🔥 HIIT' : '💼 LAVORO'}
                </button>
              ))}
            </div>
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#888', fontSize: '0.7rem', marginBottom: '8px', gap: '8px' }}>
                <span>0:00</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="text" inputMode="numeric" placeholder="Inizio" value={decimalToTimeStr(workoutStartTime)} onChange={(e) => setWorkoutStartTime(Math.min(workoutEndTime - 0.25, parseTimeStrToDecimal(e.target.value)))} style={{ width: '56px', padding: '6px 8px', background: '#1a1a1a', border: '1px solid #ff6d00', borderRadius: '8px', color: '#ff6d00', fontSize: '0.95rem', fontWeight: 'bold', textAlign: 'center' }} />
                  <span style={{ color: '#666' }}>–</span>
                  <input type="text" inputMode="numeric" placeholder="Fine" value={decimalToTimeStr(workoutEndTime)} onChange={(e) => setWorkoutEndTime(Math.max(workoutStartTime + 0.25, parseTimeStrToDecimal(e.target.value)))} style={{ width: '56px', padding: '6px 8px', background: '#1a1a1a', border: '1px solid #ff6d00', borderRadius: '8px', color: '#ff6d00', fontSize: '0.95rem', fontWeight: 'bold', textAlign: 'center' }} />
                </div>
                <span>24:00</span>
              </div>
              <div ref={miniTimelineActivityRef} style={{ position: 'relative', height: '36px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid #333' }}>
                {allNodes.filter(n => n.id !== editingWorkoutId).map(n => {
                  const isWork = n.type === 'work';
                  const startP = (n.time / 24) * 100;
                  const durP = isWork ? ((n.duration || 1) / 24) * 100 : 0;
                  const isPesi = n.type === 'workout' && n.subType === 'pesi' && n.muscles?.length > 0;
                  const iconContent = isPesi ? n.muscles.map(m => m.substring(0, 2).toUpperCase()).join('+') : (n.icon || '•');
                  if (isWork) {
                    return (
                      <div key={n.id} style={{ position: 'absolute', left: `${startP}%`, width: `${durP}%`, top: '50%', transform: 'translateY(-50%)', height: '20px', background: 'rgba(255, 234, 0, 0.2)', borderLeft: '2px solid #ffea00', borderRight: '2px solid #ffea00', borderRadius: '4px', filter: 'grayscale(1)', opacity: 0.3, pointerEvents: 'none' }}></div>
                    );
                  }
                  return (
                    <div key={n.id} style={{ position: 'absolute', left: `${startP}%`, top: '50%', transform: 'translate(-50%, -50%)', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(0,0,0,0.5)', border: '2px solid #666', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', filter: 'grayscale(1)', opacity: 0.3, pointerEvents: 'none', fontSize: '0.5rem' }}>
                      <span style={{ lineHeight: 1 }}>{iconContent}</span>
                    </div>
                  );
                })}
                <div onPointerDown={(e) => handleMiniTimelineDrag(e, miniTimelineActivityRef, 'bar-all', workoutStartTime, workoutEndTime, setWorkoutStartTime, setWorkoutEndTime)} style={{ position: 'absolute', left: `${(workoutStartTime/24)*100}%`, width: `${((workoutEndTime - workoutStartTime)/24)*100}%`, top: '50%', transform: 'translateY(-50%)', height: '24px', background: 'rgba(255, 109, 0, 0.4)', border: '1px solid #ff6d00', borderRadius: '4px', cursor: 'grab', zIndex: 10 }}>
                  <div onPointerDown={(e) => { e.stopPropagation(); handleMiniTimelineDrag(e, miniTimelineActivityRef, 'bar-start', workoutStartTime, workoutEndTime, setWorkoutStartTime, setWorkoutEndTime); }} style={{ position: 'absolute', left: '-10px', top: '50%', transform: 'translateY(-50%)', width: '20px', height: '28px', background: '#ff6d00', borderRadius: '4px', cursor: 'ew-resize', zIndex: 11 }}></div>
                  <div onPointerDown={(e) => { e.stopPropagation(); handleMiniTimelineDrag(e, miniTimelineActivityRef, 'bar-end', workoutStartTime, workoutEndTime, setWorkoutStartTime, setWorkoutEndTime); }} style={{ position: 'absolute', right: '-10px', top: '50%', transform: 'translateY(-50%)', width: '20px', height: '28px', background: '#ff6d00', borderRadius: '4px', cursor: 'ew-resize', zIndex: 11 }}></div>
                </div>
              </div>
            </div>
            {workoutType === 'pesi' && (
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#aaa', marginBottom: '8px' }}>Gruppi Muscolari (Max 2)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {['Gambe', 'Petto', 'Tricipiti', 'Bicipiti', 'ABS', 'Schiena', 'Spalle'].map(m => {
                    const isActive = workoutMuscles.includes(m);
                    return (
                      <button key={m} type="button" onClick={() => {
                        setWorkoutMuscles(prev => {
                          if (prev.includes(m)) return prev.filter(x => x !== m);
                          if (prev.length >= 2) return [prev[1], m];
                          return [...prev, m];
                        });
                      }} style={{ padding: '8px 12px', fontSize: '0.75rem', borderRadius: '20px', border: '1px solid #444', background: isActive ? '#ff6d00' : '#222', color: isActive ? '#000' : '#aaa', fontWeight: isActive ? 'bold' : 'normal', cursor: 'pointer' }}>
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="burn-slider-container">
              <span className="burn-label" style={{color: '#ff6d00'}}>OUTPUT ENERGETICO STIMATO</span>
              <div className="burn-value workout">{workoutKcal}</div>
              <input type="range" min="50" max="1500" step="10" value={workoutKcal} onChange={(e) => setWorkoutKcal(Number(e.target.value))} className="custom-range orange" style={{ marginTop: '20px' }} />
            </div>
            <button onClick={handleSaveWorkout} style={{ width: '100%', padding: '18px', backgroundColor: '#ff6d00', color: '#000', border: 'none', borderRadius: '15px', fontSize: '0.9rem', fontWeight: 'bold', letterSpacing: '2px', cursor: 'pointer', transition: '0.2s', boxShadow: '0 0 20px rgba(255, 109, 0, 0.4)' }}>SALVA ATTIVITÀ</button>
            <div style={{ marginTop: '30px' }}>
              {workoutsLog.length > 0 && <h4 style={{ fontSize: '0.65rem', color: '#666', letterSpacing: '2px', marginBottom: '10px' }}>OUTPUT REGISTRATI OGGI</h4>}
              {workoutsLog.map(wk => (
                <div key={wk.id} className="food-pill" style={{ borderLeft: '3px solid #ff6d00' }}>
                  <div><span className="food-pill-name">{wk.desc || wk.name}</span><span className="food-pill-weight" style={{color: '#ff6d00'}}>{Math.round(wk.kcal)} kcal</span></div>
                  <div className="food-pill-actions"><button className="food-pill-btn btn-delete" onClick={() => removeLogItem(wk.id)}>✕</button></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* VISTA PASTO RAPIDO - CON BOTTONI CANONICI */}
        {activeAction === 'pasto' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; INDIETRO</button>
              <h2 style={{ fontSize: '0.8rem', color: '#fff', letterSpacing: '2px', margin: 0 }}>NUOVO PASTO</h2>
              <div style={{ width: '70px' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '15px', overflowX: 'auto', paddingBottom: '5px' }}>
              {[
                { label: 'Colazione', id: 'merenda1' },
                { label: 'Snack', id: 'snack' },
                { label: 'Pranzo', id: 'pranzo' },
                { label: 'Cena', id: 'cena' }
              ].map(({ label, id }) => (
                  <button
                    key={id}
                    className={`type-btn ${mealType === id ? 'active' : ''}`}
                    onClick={() => {
                      setMealType(id);
                      const t = getDefaultMealTime(id);
                      setDrawerMealTime(t);
                      setDrawerMealTimeStr(decimalToTimeStr(t));
                    }}
                    style={{ whiteSpace: 'nowrap', padding: '12px 15px' }}
                  >
                    {label}
                  </button>
              ))}
            </div>
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#888', fontSize: '0.7rem', marginBottom: '8px' }}>
                <span>0:00</span>
                <input type="text" inputMode="numeric" value={drawerMealTimeStr} onChange={(e) => handleTimeInput(e.target.value)} style={{ width: '72px', padding: '8px 10px', background: '#1a1a1a', border: '1px solid #00e5ff', borderRadius: '8px', color: '#00e5ff', fontSize: '1.1rem', fontWeight: 'bold', textAlign: 'center', letterSpacing: '1px' }} />
                <span>24:00</span>
              </div>
              <div ref={miniTimelinePastoRef} style={{ position: 'relative', height: '36px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid #333' }}>
                {allNodes.filter(n => n.id !== `${mealType}_${drawerMealTime}`).map(n => {
                  const isWork = n.type === 'work';
                  const startP = (n.time / 24) * 100;
                  const durP = isWork ? ((n.duration || 1) / 24) * 100 : 0;
                  const isPesi = n.type === 'workout' && n.subType === 'pesi' && n.muscles?.length > 0;
                  const iconContent = isPesi ? n.muscles.map(m => m.substring(0, 2).toUpperCase()).join('+') : (n.icon || '•');
                  if (isWork) {
                    return (
                      <div key={n.id} style={{ position: 'absolute', left: `${startP}%`, width: `${durP}%`, top: '50%', transform: 'translateY(-50%)', height: '20px', background: 'rgba(255, 234, 0, 0.2)', borderLeft: '2px solid #ffea00', borderRight: '2px solid #ffea00', borderRadius: '4px', filter: 'grayscale(1)', opacity: 0.3, pointerEvents: 'none' }}></div>
                    );
                  }
                  return (
                    <div key={n.id} style={{ position: 'absolute', left: `${startP}%`, top: '50%', transform: 'translate(-50%, -50%)', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(0,0,0,0.5)', border: '2px solid #666', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', filter: 'grayscale(1)', opacity: 0.3, pointerEvents: 'none', fontSize: '0.5rem' }}>
                      <span style={{ lineHeight: 1 }}>{iconContent}</span>
                    </div>
                  );
                })}
                <div onPointerDown={(e) => handleMiniTimelineDrag(e, miniTimelinePastoRef, 'point', drawerMealTime, null, setDrawerMealTime, null)} style={{ position: 'absolute', left: `${(drawerMealTime/24)*100}%`, top: '50%', transform: 'translate(-50%, -50%)', width: '28px', height: '28px', borderRadius: '50%', background: '#00e5ff', border: '2px solid #fff', cursor: 'ew-resize', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10, boxShadow: '0 0 10px rgba(0,229,255,0.5)' }}>
                  <span style={{ fontSize: '0.5rem', fontWeight: 'bold', color: '#000' }}>{decimalToTimeStr(drawerMealTime)}</span>
                  <span style={{ lineHeight: 1 }}>🍎</span>
                </div>
              </div>
            </div>
            <div style={{ marginBottom: '16px', padding: '12px', borderRadius: '10px', border: '1px solid #333', background: energyAt20Percent < 40 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(34, 197, 94, 0.1)', borderColor: energyAt20Percent < 40 ? 'rgba(220, 38, 38, 0.4)' : 'rgba(34, 197, 94, 0.35)' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: '600', color: energyAt20Percent < 40 ? '#f87171' : '#4ade80', marginBottom: '4px' }}>Analisi Bio-Feedback</div>
              {energyAt20Percent < 40 ? (
                <p style={{ margin: 0, fontSize: '0.7rem', color: '#fca5a5', lineHeight: 1.4 }}>⚠️ Rischio Cortisolo Alto rilevato. Si consiglia di aumentare la quota di carboidrati complessi o grassi sani in questo pasto per stabilizzare i livelli serali.</p>
              ) : (
                <p style={{ margin: 0, fontSize: '0.7rem', color: '#86efac', lineHeight: 1.4 }}>✅ Equilibrio Serale Ottimale. La strategia attuale supporta bassi livelli di stress.</p>
              )}
            </div>
            <div style={{ position: 'relative', marginBottom: '20px' }}>
              {isBarcodeScannerOpen && (
                <div style={{ marginBottom: '12px', borderRadius: '12px', overflow: 'hidden', background: '#000', border: '1px solid #333' }}>
                  <video ref={barcodeVideoRef} muted playsInline style={{ width: '100%', maxHeight: '200px', display: 'block' }} />
                  <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.75rem', color: '#888' }}>Inquadra il codice a barre</span>
                    <button type="button" onClick={() => { setIsBarcodeScannerOpen(false); barcodeStreamRef.current?.getTracks().forEach(t => t.stop()); barcodeStreamRef.current = null; clearInterval(barcodeScanIntervalRef.current); }} style={{ padding: '6px 12px', background: '#333', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '0.8rem', cursor: 'pointer' }}>Chiudi</button>
                  </div>
                </div>
              )}
              <div className="quick-add-bar">
                <input
                  type="text"
                  className="quick-input input-name"
                  placeholder="Es. Pollo"
                  value={foodNameInput}
                  onChange={(e) => setFoodNameInput(e.target.value)}
                  onFocus={() => setShowFoodDropdown(true)}
                  onBlur={() => setTimeout(() => setShowFoodDropdown(false), 200)}
                  onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('weight-input')?.focus(); }}
                />
                <input id="weight-input" type="number" className="quick-input input-weight" placeholder="g" value={foodWeightInput} onChange={(e) => setFoodWeightInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddFoodManual()} />
                <button type="button" title="Scansiona barcode" onClick={() => setIsBarcodeScannerOpen(prev => !prev)} style={{ padding: '10px 12px', background: isBarcodeScannerOpen ? '#00e5ff' : 'rgba(255,255,255,0.08)', border: '1px solid #333', borderRadius: '10px', cursor: 'pointer', fontSize: '1.1rem' }}>📷</button>
                <button className="quick-add-btn" onClick={handleAddFoodManual}>+</button>
              </div>
              {showFoodDropdown && (foodNameInput.trim() || foodDropdownSuggestions.length > 0) && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#1a1a1a', border: '1px solid #333', borderRadius: '0 0 12px 12px', maxHeight: '220px', overflowY: 'auto', zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                  {foodDropdownSuggestions.map(s => (
                    <button key={s.key} type="button" style={{ width: '100%', padding: '12px 16px', textAlign: 'left', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.9rem', borderBottom: '1px solid #2a2a2a' }} onClick={() => { setFoodNameInput(s.desc); setFoodWeightInput(getLastQuantityForFood(s.desc) || ''); setShowFoodDropdown(false); setTimeout(() => document.getElementById('weight-input')?.focus(), 50); }}>
                      {s.desc}
                    </button>
                  ))}
                  {foodNameInput.trim() && (
                    <button type="button" style={{ width: '100%', padding: '12px 16px', textAlign: 'left', background: 'rgba(179, 136, 255, 0.15)', border: 'none', color: '#b388ff', cursor: isGeneratingFood ? 'wait' : 'pointer', fontSize: '0.9rem', fontWeight: '600' }} onClick={() => generateFoodWithAI(foodNameInput.trim())} disabled={isGeneratingFood}>
                      {isGeneratingFood ? '⏳ Generazione in corso...' : `✨ Genera con AI: "${foodNameInput.trim()}"`}
                    </button>
                  )}
                </div>
              )}
            </div>
            <div style={{ minHeight: '100px', marginBottom: '20px' }}>
              {addedFoods.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#444', fontSize: '0.8rem', fontStyle: 'italic', marginTop: '30px' }}>Nessun alimento in coda</p>
              ) : (
                addedFoods.map((food) => {
                  const omega3G = (food.omega3 != null && food.omega3 > 0) ? (food.omega3 >= 1 ? food.omega3 : food.omega3 / 1000) : 0;
                  const omega3Rich = omega3G > 0.5;
                  const mgVal = Number(food.mg) || 0;
                  const mgRich = mgVal >= 30;
                  return (
                    <div key={food.id} className="food-pill">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                          <span className="food-pill-name">{food.desc || food.name}</span>
                          <span className="food-pill-weight">{food.qta || food.weight}g</span>
                          {(omega3Rich || mgRich) && (
                            <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
                              {omega3Rich && <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '10px', background: 'rgba(0, 150, 255, 0.25)', color: '#5eb3f6', fontWeight: '600' }}>Ω3</span>}
                              {mgRich && <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '10px', background: 'rgba(139, 90, 43, 0.35)', color: '#d4a574', fontWeight: '600' }}>Mg</span>}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="food-pill-actions">
                        <button className="food-pill-btn" onClick={() => setSelectedFoodForInfo(food)} title="Info macro/micro">ℹ️</button>
                        <button className="food-pill-btn" onClick={() => { setSelectedFoodForEdit({ food, source: 'queue' }); setEditQuantityValue(String(food.qta ?? food.weight ?? 100)); }} title="Modifica quantità">✏️</button>
                        <button className="food-pill-btn btn-delete" onClick={() => setAddedFoods(addedFoods.filter(f => f.id !== food.id))}>✕</button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {addedFoods.length > 0 && (
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #2a2a2a', borderRadius: '12px', padding: '15px', marginBottom: '20px' }}>
                <h4 style={{ fontSize: '0.65rem', color: '#b388ff', letterSpacing: '1px', marginBottom: '10px', textTransform: 'uppercase' }}>Bilancio Pasto ({MEAL_LABELS_SAVE[mealType] || mealType})</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  {renderMiniBar('KCAL', currentMealTotals.kcal, targetMacrosPasto.kcal, '#00e5ff')}
                  {renderMiniBar('PROT (g)', currentMealTotals.prot, targetMacrosPasto.prot, '#b388ff')}
                  {renderMiniBar('CARB (g)', currentMealTotals.carb, targetMacrosPasto.carb, '#00e676')}
                  {renderMiniBar('FAT (g)', currentMealTotals.fat, targetMacrosPasto.fat, '#ffea00')}
                  {renderMiniBar('FIBRE (g)', currentMealTotals.fibre, targetMacrosPasto.fibre, '#ff6d00')}
                </div>
              </div>
            )}
            <button onClick={saveMealToDiary} style={{ width: '100%', padding: '18px', backgroundColor: '#fff', color: '#000', border: 'none', borderRadius: '15px', fontSize: '0.9rem', fontWeight: 'bold', letterSpacing: '2px', cursor: 'pointer', transition: '0.2s', opacity: addedFoods.length > 0 ? 1 : 0.5 }}>SALVA NEL DIARIO</button>
          </div>
        )}

        {/* VISTA DIARIO GIORNALIERO */}
        {activeAction === 'diario_giornaliero' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; INDIETRO</button>
              <h2 style={{ fontSize: '0.8rem', color: '#00e676', letterSpacing: '2px', margin: 0 }}>📓 DIARIO GIORNALIERO</h2>
              <div style={{ width: '70px' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', background: '#111', padding: '5px', borderRadius: '15px' }}>
              <button className={`type-btn ${diarioTab === 'storico' ? 'active blue' : ''}`} onClick={() => setDiarioTab('storico')} style={{ border: 'none' }}>OGGI</button>
              <button className={`type-btn ${diarioTab === 'telemetria' ? 'active blue' : ''}`} onClick={() => setDiarioTab('telemetria')} style={{ border: 'none' }}>TELEMETRIA (40)</button>
            </div>
            {diarioTab === 'storico' && (
              <div style={{ minHeight: '200px' }}>
                {workoutsLog.length > 0 && (
                  <div style={{ marginBottom: '20px' }}>
                    <h4 style={{ fontSize: '0.7rem', color: '#ff6d00', letterSpacing: '1px', marginBottom: '8px' }}>OUTPUT ENERGETICO</h4>
                    {workoutsLog.map(wk => (
                      <div key={wk.id} className="food-pill" style={{ borderLeft: '3px solid #ff6d00', background: 'rgba(255, 109, 0, 0.05)' }}>
                        <div>
                          <div style={{ fontSize: '0.85rem', fontWeight: '600', color: '#fff' }}>{wk.desc || wk.name}</div>
                          <div style={{ fontSize: '0.65rem', color: '#888', marginTop: '2px' }}>Stima: {wk.duration || Math.round((wk.kcal || 0) / 6)} min</div>
                        </div>
                        <div className="food-pill-actions">
                          <div style={{ color: '#ff6d00', fontWeight: 'bold', fontSize: '1rem', marginRight: '10px' }}>🔥 {Math.round(wk.kcal || wk.cal || 0)}</div>
                          <button className="food-pill-btn btn-delete" onClick={() => removeLogItem(wk.id)}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {Object.keys(groupedFoods).length === 0 && workoutsLog.length === 0 ? (
                  <p style={{ textAlign: 'center', color: '#444', fontSize: '0.8rem', fontStyle: 'italic' }}>Nessuna traccia registrata oggi.</p>
                ) : (
                  Object.keys(groupedFoods).map(slotKey => {
                    const items = groupedFoods[slotKey];
                    const mType = items[0]?.mealType || slotKey.split('_')[0];
                    const mTime = items[0]?.mealTime ?? 12;
                    const label = `${MEAL_LABELS_SAVE[toCanonicalMealType(mType)] || mType} (${decimalToTimeStr(mTime)})`;

                    return (
                      <div key={slotKey} style={{ marginBottom: '20px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                          <h4 style={{ fontSize: '0.7rem', color: '#888', letterSpacing: '1px', margin: 0, cursor: 'pointer', flex: 1 }} onClick={() => setSelectedNodeReport({ id: slotKey, type: 'meal' })}>
                            {label}
                          </h4>
                          <button type="button" className="food-pill-btn" onClick={() => setSelectedNodeReport({ id: slotKey, type: 'meal' })} title="Dettaglio pasto">✏️</button>
                        </div>
                        {items.map(food => (
                          <div key={food.id} className="food-pill" style={{ borderLeft: '3px solid #333', cursor: 'pointer' }} onClick={() => setSelectedNodeReport({ id: slotKey, type: 'meal' })}>
                            <div>
                              <span className="food-pill-name">{food.desc || food.name}</span>
                              <span className="food-pill-weight">{food.qta || food.weight}g</span>
                            </div>
                            <div className="food-pill-actions" onClick={(e) => e.stopPropagation()}>
                              <button className="food-pill-btn" onClick={(e) => { e.stopPropagation(); setSelectedFoodForInfo(food); }} title="Info macro/micro">ℹ️</button>
                              <button className="food-pill-btn" onClick={(e) => { e.stopPropagation(); setSelectedNodeReport({ id: slotKey, type: 'meal' }); }} title="Dettaglio pasto">✏️</button>
                              <div style={{ fontSize: '0.75rem', color: '#888', marginRight: '10px' }}>{Math.round(food.kcal || food.cal || 0)} kcal</div>
                              <button className="food-pill-btn btn-delete" onClick={(e) => { e.stopPropagation(); removeLogItem(food.id); }}>✕</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })
                )}
              </div>
            )}
            {diarioTab === 'telemetria' && (
              <div className="view-animate">
                <div style={{ display: 'flex', gap: '5px', marginBottom: '20px', overflowX: 'auto', paddingBottom: '5px' }}>
                  {['macro', 'bilanci', 'amino', 'vit', 'min', 'fat'].map(t => (
                    <button key={t} onClick={() => setTelemetrySubTab(t)} style={{ padding: '8px 15px', fontSize: '0.7rem', background: telemetrySubTab === t ? '#00e676' : '#111', color: telemetrySubTab === t ? '#000' : '#888', border: 'none', borderRadius: '20px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{t}</button>
                  ))}
                </div>
                <div style={{ background: '#111', padding: '20px', borderRadius: '15px' }}>
                  {telemetrySubTab === 'macro' && (<> {renderProgressBar('PROTEINE', totali.prot, userTargets.prot ?? TARGETS.macro.prot, 'g', 'prot')} {renderProgressBar('CARBOIDRATI', totali.carb, userTargets.carb ?? TARGETS.macro.carb, 'g', 'carb')} {renderProgressBar('GRASSI TOTALI', totali.fatTotal, userTargets.fatTotal ?? TARGETS.macro.fatTotal, 'g', 'fatTotal')} </>)}
                  {telemetrySubTab === 'bilanci' && (
                    <div className="view-animate">
                      <h4 style={{ fontSize: '0.7rem', color: '#b0bec5', letterSpacing: '1px', marginBottom: '15px' }}>RAPPORTI BIOCHIMICI</h4>
                      {renderRatioBar(
                        'Equilibrio Elettrolitico (Idratazione)',
                        'Sodio (Na)', totali?.na,
                        'Potassio (K)', totali?.k,
                        'Ideale: Na < K',
                        (Number(totali?.na) || 0) < (Number(totali?.k) || 0)
                      )}
                      {renderRatioBar(
                        'Indice Infiammatorio (Grassi)',
                        'Omega 6', totali?.omega6,
                        'Omega 3', totali?.omega3,
                        'Ideale: W6:W3 < 4:1',
                        (Number(totali?.omega6) || 0) <= (Number(totali?.omega3) || 1) * 4
                      )}
                    </div>
                  )}
                  {telemetrySubTab === 'amino' && (<> {Object.keys(TARGETS.amino).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.amino[k], 'mg', k))} </>)}
                  {telemetrySubTab === 'vit' && (<> {Object.keys(TARGETS.vit).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.vit[k], k === 'vitA' || k === 'b9' ? 'µg' : 'mg', k))} </>)}
                  {telemetrySubTab === 'min' && (<> {Object.keys(TARGETS.min).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.min[k], k === 'se' ? 'µg' : 'mg', k))} </>)}
                  {telemetrySubTab === 'fat' && (<> {Object.keys(TARGETS.fat).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.fat[k], 'g', k))} </>)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* VISTA ARCHIVIO STORICO */}
        {activeAction === 'storico' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <button onClick={() => setActiveAction(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; INDIETRO</button>
              <h2 style={{ fontSize: '0.8rem', color: '#b0bec5', letterSpacing: '2px', margin: 0 }}>📚 ARCHIVIO STORICO</h2>
              <div style={{ width: '70px' }}></div>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#888', letterSpacing: '1px', marginBottom: '8px' }}>Cerca per data</label>
              <input
                type="date"
                value={selectedHistoryDate}
                onChange={(e) => setSelectedHistoryDate(e.target.value)}
                style={{ width: '100%', padding: '12px 14px', background: '#111', border: '1px solid #2a2a2a', borderRadius: '10px', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
              />
            </div>
            <div style={{ marginBottom: '24px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '12px', border: '1px solid #2a2a2a' }}>
              <h4 style={{ fontSize: '0.7rem', color: '#b0bec5', letterSpacing: '1px', marginBottom: '15px' }}>TREND CALORICO ULTIMI 7 GIORNI</h4>
              {weeklyTrendData.length > 0 ? (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={weeklyTrendData} margin={{ top: 10, right: 0, left: -25, bottom: 0 }}>
                    <XAxis dataKey="shortDate" tick={{ fill: '#666', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, (min, max) => (max ?? 0) + 200]} tick={{ fill: '#666', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: '#111', border: '1px solid #333', borderRadius: '8px', fontSize: '0.8rem' }} />
                    <ReferenceLine y={userTargets.kcal ?? STRATEGY_PROFILES[dayProfile]?.kcal ?? 2300} stroke="rgba(0, 229, 255, 0.4)" strokeDasharray="3 3" />
                    <Bar dataKey="calorie" fill="#b0bec5" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p style={{ fontSize: '0.75rem', color: '#666', fontStyle: 'italic', textAlign: 'center' }}>Dati insufficienti per il trend settimanale.</p>
              )}
            </div>
            {weeklyTrendData.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '24px' }}>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '12px', border: '1px solid #2a2a2a' }}>
                  <h4 style={{ fontSize: '0.65rem', color: '#ffea00', letterSpacing: '1px', marginBottom: '15px' }}>GRASSI (7 GIORNI)</h4>
                  {renderWeeklyBar('Grassi Totali', weeklyMicrosTotals.fatTotal, userTargets.fatTotal ?? TARGETS.macro.fatTotal, 'g', 'fatTotal')}
                  {renderWeeklyBar('Omega 3', weeklyMicrosTotals.omega3, userTargets.omega3 ?? TARGETS.fat.omega3, 'g', 'omega3')}
                  {renderWeeklyBar('Omega 6', weeklyMicrosTotals.omega6, TARGETS.fat.omega6, 'g', 'omega6')}
                </div>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '12px', border: '1px solid #2a2a2a' }}>
                  <h4 style={{ fontSize: '0.65rem', color: '#00e676', letterSpacing: '1px', marginBottom: '15px' }}>ACCUMULABILI (LIPO + B12)</h4>
                  {renderWeeklyBar('Vitamina A', weeklyMicrosTotals.vitA, TARGETS.vit.vitA, 'µg', 'vitA')}
                  {renderWeeklyBar('Vitamina D', weeklyMicrosTotals.vitD, userTargets.vitD ?? TARGETS.vit.vitD, 'µg', 'vitD')}
                  {renderWeeklyBar('Vitamina E', weeklyMicrosTotals.vitE, TARGETS.vit.vitE, 'mg', 'vitE')}
                  {renderWeeklyBar('Vitamina K', weeklyMicrosTotals.vitK, TARGETS.vit.vitK, 'µg', 'vitK')}
                  {renderWeeklyBar('Vitamina B12', weeklyMicrosTotals.vitB12, TARGETS.vit.vitB12, 'µg', 'vitB12')}
                </div>
              </div>
            )}
            {selectedHistoryDate && (
              <div style={{ marginBottom: '24px', padding: '16px', background: 'rgba(176, 190, 197, 0.06)', border: '1px solid rgba(176, 190, 197, 0.2)', borderRadius: '12px' }}>
                {selectedDayData ? (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '12px', fontSize: '0.8rem' }}>
                      <span style={{ color: '#b0bec5' }}>{new Date(selectedHistoryDate + 'T12:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                      <span style={{ color: '#00e5ff' }}>{Math.round(selectedDayData.calorie)} kcal</span>
                      <span style={{ color: '#b388ff' }}>{selectedDayData.proteine.toFixed(1)} g prot</span>
                      <span style={{ color: selectedDayData.deficit < 0 ? '#00e676' : selectedDayData.deficit > 0 ? '#ff6d00' : '#888' }}>
                        {selectedDayData.deficit < 0 ? `${selectedDayData.deficit} kcal (Deficit)` : selectedDayData.deficit > 0 ? `+${selectedDayData.deficit} kcal (Surplus)` : '0 kcal (Pari)'}
                      </span>
                    </div>
                    <h4 style={{ fontSize: '0.7rem', color: '#b0bec5', letterSpacing: '1px', marginBottom: '8px' }}>Dettaglio</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {(selectedDayData.log || []).map((entry, idx) => {
                        if (entry.type === 'meal' && entry.items) {
                          const tot = (entry.items || []).reduce((a, it) => ({ prot: a.prot + (it.prot || 0), cal: a.cal + ((it.cal || it.kcal) || 0) }), { prot: 0, cal: 0 });
                          return (
                            <div key={idx}>
                              <div style={{ fontSize: '0.8rem', fontWeight: '600', color: '#e4e6eb' }}>{entry.desc || 'Pasto'} — {tot.prot.toFixed(1)} g prot, {Math.round(tot.cal)} kcal</div>
                              {(entry.items || []).map((item, i) => (
                                <div key={i} style={{ paddingLeft: '12px', fontSize: '0.75rem', color: '#b0b3b8' }}>{item.desc} · {(item.qta || item.weight) || ''}g · {Math.round((item.cal || item.kcal) || 0)} kcal</div>
                              ))}
                            </div>
                          );
                        }
                        if (entry.type === 'single' || !entry.type) {
                          return <div key={idx} style={{ fontSize: '0.8rem', color: '#b0b3b8' }}>{entry.desc} · {Math.round((entry.cal || entry.kcal) || 0)} kcal</div>;
                        }
                        if (entry.type === 'workout') {
                          return <div key={idx} style={{ fontSize: '0.8rem', color: '#ff6d00' }}>{entry.desc} — {Math.round((entry.cal || entry.kcal) || 0)} kcal (bruciate)</div>;
                        }
                        return null;
                      })}
                    </div>
                  </>
                ) : (
                  <p style={{ margin: 0, fontSize: '0.85rem', color: '#888', fontStyle: 'italic' }}>Nessun dato registrato per questa data.</p>
                )}
              </div>
            )}
            <h3 className="diary-group-title" style={{ borderLeftColor: '#b0bec5', marginBottom: '12px' }}>Tutti i giorni</h3>
            {pastDaysStorico.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#444', fontSize: '0.8rem', fontStyle: 'italic' }}>Nessun giorno passato in archivio.</p>
            ) : (
              <div className="storico-accordion">
                {pastDaysStorico.map(({ dataStr, log, calorie, proteine, deficit }) => {
                  const isExpanded = expandedStoricoDate === dataStr;
                  const dataFormatted = new Date(dataStr + 'T12:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                  const deficitText = deficit < 0 ? `${deficit} kcal (Deficit)` : deficit > 0 ? `+${deficit} kcal (Surplus)` : '0 kcal (Pari)';
                  return (
                    <div key={dataStr} style={{ marginBottom: '8px', border: '1px solid #2a2a2a', borderRadius: '12px', overflow: 'hidden', background: isExpanded ? 'rgba(176, 190, 197, 0.06)' : 'rgba(255,255,255,0.02)' }}>
                      <button type="button" onClick={() => setExpandedStoricoDate(isExpanded ? null : dataStr)} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', textAlign: 'left', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>{dataFormatted}</span>
                        <span style={{ fontSize: '0.75rem', color: '#00e5ff' }}>{Math.round(calorie)} kcal</span>
                        <span style={{ fontSize: '0.75rem', color: '#b388ff' }}>{proteine.toFixed(1)} g prot</span>
                        <span style={{ fontSize: '0.75rem', color: deficit < 0 ? '#00e676' : deficit > 0 ? '#ff6d00' : '#888' }}>{deficitText}</span>
                        <span style={{ fontSize: '1rem', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▶</span>
                      </button>
                      {isExpanded && (
                        <div style={{ padding: '12px 16px 16px', borderTop: '1px solid #2a2a2a', background: 'rgba(0,0,0,0.3)' }}>
                          <h4 style={{ fontSize: '0.7rem', color: '#b0bec5', letterSpacing: '1px', marginBottom: '10px' }}>Dettaglio pasti e alimenti</h4>
                          {(log || []).length === 0 ? (
                            <p style={{ fontSize: '0.8rem', color: '#666', fontStyle: 'italic' }}>Nessun dettaglio per questo giorno.</p>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {(log || []).map((entry, idx) => {
                                if (entry.type === 'meal' && entry.items) {
                                  const totPasto = (entry.items || []).reduce((a, it) => ({ prot: a.prot + (it.prot || 0), cal: a.cal + ((it.cal || it.kcal) || 0) }), { prot: 0, cal: 0 });
                                  return (
                                    <div key={idx} style={{ marginBottom: '4px' }}>
                                      <div style={{ fontSize: '0.8rem', fontWeight: '600', color: '#e4e6eb', marginBottom: '4px' }}>{entry.desc || 'Pasto'} — {totPasto.prot.toFixed(1)} g prot, {Math.round(totPasto.cal)} kcal</div>
                                      {(entry.items || []).map((item, i) => (
                                        <div key={i} style={{ paddingLeft: '16px', fontSize: '0.8rem', color: '#b0b3b8', display: 'flex', justifyContent: 'space-between' }}>
                                          <span>{item.desc}</span>
                                          <span>{item.qta || item.weight}g · {(item.prot || 0).toFixed(1)} g · {Math.round((item.cal || item.kcal) || 0)} kcal</span>
                                        </div>
                                      ))}
                                    </div>
                                  );
                                }
                                if (entry.type === 'single' || !entry.type) {
                                  return (
                                    <div key={idx} style={{ fontSize: '0.8rem', color: '#b0b3b8', display: 'flex', justifyContent: 'space-between' }}>
                                      <span>{entry.desc}</span>
                                      <span>{(entry.qta || entry.weight) || ''}g · {(entry.prot || 0).toFixed(1)} g · {Math.round((entry.cal || entry.kcal) || 0)} kcal</span>
                                    </div>
                                  );
                                }
                                if (entry.type === 'workout') {
                                  return (
                                    <div key={idx} style={{ fontSize: '0.8rem', color: '#ff6d00', display: 'flex', justifyContent: 'space-between' }}>
                                      <span>{entry.desc}</span>
                                      <span>{Math.round((entry.cal || entry.kcal) || 0)} kcal (bruciate)</span>
                                    </div>
                                  );
                                }
                                return null;
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* VISTA ZEN */}
        {activeAction === 'focus' && (
          <div className="view-animate">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <button onClick={() => { setIsZenActive(false); setActiveAction(null); }} style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '1px' }}>&lt; INDIETRO</button>
              <h2 style={{ fontSize: '0.8rem', color: '#fbc02d', letterSpacing: '2px', margin: 0 }}>🧘 NEURAL RESET</h2>
              <div style={{ width: '70px' }}></div>
            </div>
            <p style={{ textAlign: 'center', color: '#888', fontSize: '0.75rem', marginBottom: '20px' }}>Sincronizza il respiro con l'anello per abbassare il ritmo cardiaco.</p>
            <div className="zen-container">
              <div className={`zen-orb ${isZenActive ? 'breathing' : ''}`}></div>
              <div className="zen-rings"></div>
              <div className="zen-instruction" style={{ display: isZenActive ? 'block' : 'none' }}></div>
              {!isZenActive && <div style={{ position: 'absolute', bottom: '0', fontSize: '0.8rem', color: '#555', letterSpacing: '2px' }}>IN ATTESA</div>}
            </div>
            <button onClick={() => setIsZenActive(!isZenActive)} style={{ width: '100%', padding: '18px', backgroundColor: isZenActive ? '#222' : '#fbc02d', color: isZenActive ? '#fbc02d' : '#000', border: isZenActive ? '1px solid #fbc02d' : 'none', borderRadius: '15px', fontSize: '0.9rem', fontWeight: 'bold', letterSpacing: '2px', cursor: 'pointer', transition: '0.3s', boxShadow: isZenActive ? 'none' : '0 0 20px rgba(251, 192, 45, 0.3)' }}>
              {isZenActive ? 'TERMINA SESSIONE' : 'AVVIA CICLO'}
            </button>
          </div>
        )}

        {/* Modale Info alimento */}
        {selectedFoodForInfo && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '20px' }} onClick={() => setSelectedFoodForInfo(null)}>
            <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', maxWidth: '400px', width: '100%', maxHeight: '80vh', overflow: 'auto', padding: '20px' }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', color: '#00e5ff' }}>{selectedFoodForInfo.desc || selectedFoodForInfo.name}</h3>
                <button style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.2rem', cursor: 'pointer' }} onClick={() => setSelectedFoodForInfo(null)}>✕</button>
              </div>
              <p style={{ fontSize: '0.75rem', color: '#888', marginBottom: '12px' }}>{(selectedFoodForInfo.qta ?? selectedFoodForInfo.weight ?? 100)} g</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.8rem' }}>
                <span style={{ color: '#aaa' }}>Kcal</span><span style={{ color: '#fff' }}>{Math.round(selectedFoodForInfo.kcal ?? selectedFoodForInfo.cal ?? 0)}</span>
                <span style={{ color: '#aaa' }}>Proteine</span><span style={{ color: '#fff' }}>{(Number(selectedFoodForInfo.prot) ?? 0).toFixed(1)} g</span>
                <span style={{ color: '#aaa' }}>Carboidrati</span><span style={{ color: '#fff' }}>{(Number(selectedFoodForInfo.carb) ?? 0).toFixed(1)} g</span>
                <span style={{ color: '#aaa' }}>Grassi</span><span style={{ color: '#fff' }}>{(Number(selectedFoodForInfo.fatTotal) ?? 0).toFixed(1)} g</span>
                <span style={{ color: '#aaa' }}>Fibre</span><span style={{ color: '#fff' }}>{(Number(selectedFoodForInfo.fibre) ?? 0).toFixed(1)} g</span>
              </div>
              <div style={{ marginTop: '16px', fontSize: '0.7rem', color: '#666' }}>Vitamine e minerali disponibili nel motore biochimico (40+ parametri) sono inclusi nel calcolo giornaliero.</div>
            </div>
          </div>
        )}

        {/* Modale Edit quantità */}
        {selectedFoodForEdit && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '20px' }} onClick={() => setSelectedFoodForEdit(null)}>
            <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', maxWidth: '340px', width: '100%', padding: '20px' }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', color: '#00e676' }}>Modifica quantità</h3>
                <button style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.2rem', cursor: 'pointer' }} onClick={() => setSelectedFoodForEdit(null)}>✕</button>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#ccc', marginBottom: '8px' }}>{selectedFoodForEdit.food?.desc || selectedFoodForEdit.food?.name}</p>
              <input type="number" min="1" step="1" value={editQuantityValue} onChange={(e) => setEditQuantityValue(e.target.value)} style={{ width: '100%', padding: '12px', background: '#222', border: '1px solid #444', borderRadius: '8px', color: '#fff', fontSize: '1rem', marginBottom: '16px' }} placeholder="Grammi" />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button style={{ padding: '10px 18px', background: '#333', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }} onClick={() => setSelectedFoodForEdit(null)}>Annulla</button>
                <button style={{ padding: '10px 18px', background: '#00e676', color: '#000', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => {
                  const qta = parseFloat(editQuantityValue);
                  if (!Number.isFinite(qta) || qta <= 0) return;
                  const { food, source } = selectedFoodForEdit;
                  const newItem = { ...estraiDatiFoodDb(food.desc || food.name, qta, food.mealType), id: food.id };
                  if (source === 'queue') setAddedFoods(prev => prev.map(f => f.id === food.id ? newItem : f));
                  else if (source === 'diary') setDailyLog(prev => {
                    const newLog = prev.map(f => f.id === food.id ? newItem : f);
                    syncDatiFirebase(newLog, manualNodes);
                    return newLog;
                  });
                  setSelectedFoodForEdit(null);
                }}>Salva</button>
              </div>
            </div>
          </div>
        )}

      </div>
      {nutrientModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120, padding: '20px' }} onClick={() => setNutrientModal(null)}>
          <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', maxWidth: '350px', width: '100%', maxHeight: '80vh', overflow: 'auto', padding: '20px', boxShadow: '0 10px 40px rgba(0,0,0,0.8)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '0.9rem', color: '#00e5ff', textTransform: 'uppercase', letterSpacing: '1px' }}>Fonti di {nutrientModal.label}</h3>
              <button style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.2rem', cursor: 'pointer' }} onClick={() => setNutrientModal(null)}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {getNutrientSources(nutrientModal.key, nutrientModal.target, nutrientModal.isWeekly).length === 0 ? (
                <p style={{ fontSize: '0.8rem', color: '#666', fontStyle: 'italic', textAlign: 'center', padding: '20px 0' }}>Nessuna fonte registrata.</p>
              ) : (
                getNutrientSources(nutrientModal.key, nutrientModal.target, nutrientModal.isWeekly).map((src, idx) => (
                  <div key={idx} style={{ background: 'rgba(255,255,255,0.04)', padding: '12px 15px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: '0.85rem', color: '#eee', fontWeight: '500', flex: 1 }}>{src.name}</span>
                    <div style={{ textAlign: 'right', marginLeft: '10px' }}>
                      <div style={{ fontSize: '0.9rem', color: src.percent > 50 ? '#00e676' : '#00e5ff', fontWeight: 'bold' }}>{src.percent.toFixed(1)}%</div>
                      <div style={{ fontSize: '0.65rem', color: '#888' }}>{src.amount.toFixed(1)} {nutrientModal.unit}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {showReport && (
        <div className="report-modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: '#fff', color: '#000', zIndex: 9999, overflowY: 'auto', padding: '20px' }}>
          <div className="report-no-print" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', background: '#f0f0f0', padding: '15px', borderRadius: '8px' }}>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              {[
                { val: '7', label: '1 Settimana' },
                { val: '30', label: '1 Mese' },
                { val: '90', label: '3 Mesi' },
                { val: '180', label: '6 Mesi' },
                { val: '365', label: '1 Anno' }
              ].map(p => (
                <button key={p.val} onClick={() => setReportPeriod(p.val)} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: reportPeriod === p.val ? '#0d47a1' : '#ccc', color: reportPeriod === p.val ? '#fff' : '#000', cursor: 'pointer', fontWeight: 'bold' }}>
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => window.print()} style={{ padding: '8px 16px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>🖨️ Stampa PDF</button>
              <button onClick={() => setShowReport(false)} style={{ padding: '8px 16px', background: '#d32f2f', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Chiudi</button>
            </div>
          </div>

          <div className="report-print-area">
            <h1 style={{ borderBottom: '2px solid #0d47a1', paddingBottom: '10px' }}>Analisi Carenze Nutrizionali - Vyta</h1>
            <p><strong>Periodo analizzato:</strong> Ultimi {reportPeriod} giorni</p>

            {(() => {
              const data = generateReportData();
              if (!data) return <p>Nessun dato sufficiente in questo periodo.</p>;

              const nutrientLabels = { kcal: 'Kcal', prot: 'Proteine (g)', carb: 'Carboidrati (g)', fatTotal: 'Grassi (g)', fibre: 'Fibre (g)', vitc: 'Vit. C (mg)', vitD: 'Vit. D (µg)', omega3: 'Omega 3 (g)', mg: 'Magnesio (mg)', k: 'Potassio (mg)', fe: 'Ferro (mg)', ca: 'Calcio (mg)' };
              return (
                <>
                  <p><strong>Giorni con dati registrati:</strong> {data.daysFound} su {reportPeriod}</p>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5', borderBottom: '2px solid #ddd' }}>
                        <th style={{ padding: '12px', textAlign: 'left' }}>Nutriente</th>
                        <th style={{ padding: '12px', textAlign: 'center' }}>Media Assunta</th>
                        <th style={{ padding: '12px', textAlign: 'center' }}>Target</th>
                        <th style={{ padding: '12px', textAlign: 'center' }}>Stato</th>
                      </tr>
                    </thead>
                    <tbody>
                      {REPORT_NUTRIENT_KEYS.map(key => {
                        const avg = data.averages[key];
                        const target = userTargets[key] ?? getTargetForNutrient(key);
                        if (target == null || target === 0) return null;

                        const percent = (avg / target) * 100;
                        const isDeficient = percent < 80;
                        const isWarning = percent >= 80 && percent < 95;

                        let statusColor = '#2e7d32';
                        let statusText = '✅ Ottimale';
                        if (isDeficient) { statusColor = '#d32f2f'; statusText = '❌ Carenza'; }
                        else if (isWarning) { statusColor = '#f57c00'; statusText = '⚠️ Attenzione'; }

                        return (
                          <tr key={key} style={{ borderBottom: '1px solid #ddd' }}>
                            <td style={{ padding: '12px', fontWeight: 'bold' }}>{nutrientLabels[key] || key}</td>
                            <td style={{ padding: '12px', textAlign: 'center' }}>{avg.toFixed(1)}</td>
                            <td style={{ padding: '12px', textAlign: 'center' }}>{target}</td>
                            <td style={{ padding: '12px', textAlign: 'center', color: statusColor, fontWeight: 'bold' }}>
                              {statusText} ({percent.toFixed(0)}%)
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </div>
        </div>
      )}
      {showProfile && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.9)', zIndex: 10000, overflowY: 'auto', padding: '20px' }}>
          <div style={{ background: '#1e1e1e', padding: '30px', borderRadius: '16px', maxWidth: '600px', margin: '0 auto', color: '#fff' }}>
            <h2 style={{ color: '#00e5ff', borderBottom: '1px solid #333', paddingBottom: '10px' }}>⚙️ Impostazioni Universali</h2>

            <div style={{ background: '#2c2c2c', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
              <h3 style={{ margin: '0 0 15px 0' }}>1. Dati Biometrici</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <label style={{ display: 'block' }}>Sesso: <select value={userProfile.gender} onChange={e => setUserProfile({ ...userProfile, gender: e.target.value })} style={{ width: '100%', padding: '8px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}><option value="M">Uomo</option><option value="F">Donna</option></select></label>
                <label style={{ display: 'block' }}>Età: <input type="number" min="1" max="120" value={userProfile.age} onChange={e => setUserProfile({ ...userProfile, age: parseInt(e.target.value, 10) || 30 })} style={{ width: '100%', padding: '8px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }} /></label>
                <label style={{ display: 'block' }}>Peso (kg): <input type="number" min="1" step="0.1" value={userProfile.weight} onChange={e => setUserProfile({ ...userProfile, weight: parseFloat(e.target.value) || 75 })} style={{ width: '100%', padding: '8px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }} /></label>
                <label style={{ display: 'block' }}>Altezza (cm): <input type="number" min="1" value={userProfile.height} onChange={e => setUserProfile({ ...userProfile, height: parseFloat(e.target.value) || 175 })} style={{ width: '100%', padding: '8px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }} /></label>
                <label style={{ display: 'block' }}>Stile di Vita:
                  <select value={userProfile.activityLevel} onChange={e => setUserProfile({ ...userProfile, activityLevel: e.target.value })} style={{ width: '100%', padding: '8px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}>
                    <option value="1.2">Sedentario</option>
                    <option value="1.375">Leggero (1-3 allenamenti)</option>
                    <option value="1.55">Moderato (3-5 allenamenti)</option>
                    <option value="1.725">Attivo (6-7 allenamenti)</option>
                  </select>
                </label>
                <label style={{ display: 'block' }}>Obiettivo:
                  <select value={userProfile.goal} onChange={e => setUserProfile({ ...userProfile, goal: e.target.value })} style={{ width: '100%', padding: '8px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}>
                    <option value="lose">Dimagrimento</option>
                    <option value="maintain">Mantenimento</option>
                    <option value="gain">Aumento Massa</option>
                  </select>
                </label>
              </div>
              <button type="button" onClick={calculateSmartTargets} style={{ width: '100%', padding: '12px', marginTop: '15px', background: '#ff9800', color: '#000', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✨ Auto-Calcola Target</button>
            </div>

            <div style={{ background: '#2c2c2c', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
              <h3 style={{ margin: '0 0 15px 0' }}>2. Modifica Manuale Target</h3>
              <p style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '15px' }}>Correggi manualmente i valori calcolati se il tuo nutrizionista (o l'AI) ti ha fornito numeri specifici.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px' }}>
                {Object.keys(userTargets).map(key => (
                  <label key={key} style={{ display: 'flex', flexDirection: 'column', fontSize: '0.9rem' }}>
                    <span style={{ textTransform: 'uppercase', color: '#00e5ff' }}>{key}</span>
                    <input type="number" min="0" step={key === 'omega3' || key === 'vitD' ? 0.1 : 1} value={userTargets[key] ?? ''} onChange={e => setUserTargets({ ...userTargets, [key]: parseFloat(e.target.value) || 0 })} style={{ padding: '8px', border: '1px solid #444', background: '#111', color: '#fff', borderRadius: '4px' }} />
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '15px' }}>
              <button type="button" onClick={() => setShowProfile(false)} style={{ flex: 1, padding: '12px', background: '#444', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Annulla</button>
              <button type="button" onClick={() => saveProfileToFirebase(userProfile, userTargets)} style={{ flex: 2, padding: '12px', background: '#4caf50', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💾 Salva Profilo</button>
            </div>
          </div>
        </div>
      )}
      {showChoiceModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 130, padding: '20px' }} onClick={() => setShowChoiceModal(false)}>
          <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', maxWidth: '320px', width: '100%', padding: '24px', boxShadow: '0 10px 40px rgba(0,0,0,0.8)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '1rem', color: '#fff', textAlign: 'center' }}>Cosa vuoi aggiungere?</h3>
            <div style={{ display: 'flex', gap: '12px', flexDirection: 'column' }}>
              <button type="button" onClick={() => { setShowChoiceModal(false); setAddedFoods([]); setEditingMealId(null); setDrawerMealTime(currentTime); setDrawerMealTimeStr(decimalToTimeStr(currentTime)); setActiveAction('pasto'); setIsDrawerOpen(true); }} style={{ padding: '18px', background: '#00e5ff', color: '#000', borderRadius: '12px', border: 'none', fontSize: '1.05rem', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                🍎 PASTO
              </button>
              <button type="button" onClick={() => { setShowChoiceModal(false); setEditingWorkoutId(null); setWorkoutType('pesi'); setWorkoutStartTime(currentTime); setWorkoutEndTime(currentTime + 1); setWorkoutMuscles([]); setWorkoutKcal(300); setActiveAction('allenamento'); setIsDrawerOpen(true); }} style={{ padding: '18px', background: '#ff6d00', color: '#000', borderRadius: '12px', border: 'none', fontSize: '1.05rem', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                ⚡ ATTIVITÀ
              </button>
            </div>
          </div>
        </div>
      )}
      {selectedNodeReport && (
        <div className="modal-overlay" onClick={() => setSelectedNodeReport(null)} style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.8)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: '#1e1e1e', color: '#fff', padding: '25px', borderRadius: '16px', width: '100%', maxWidth: '400px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
            <h2 style={{ margin: '0 0 20px 0', borderBottom: '1px solid #333', paddingBottom: '10px', color: '#00e5ff' }}>
              {selectedNodeReport.type === 'meal' ? '🍽️ Dettaglio Pasto' : '💪 Dettaglio Attività'}
            </h2>

            {selectedNodeReport.type === 'meal' ? (
              <div>
                {(() => {
                  const items = (dailyLog || []).filter(item => getSlotKey(item) === String(selectedNodeReport.id));
                  if (items.length === 0) return <p>Nessun alimento trovato.</p>;

                  const totals = items.reduce((acc, item) => {
                    acc.kcal += parseFloat(item.kcal || item.cal || 0);
                    acc.prot += parseFloat(item.prot || 0);
                    acc.carb += parseFloat(item.carb || 0);
                    acc.fat += parseFloat(item.fatTotal || item.fat || 0);
                    return acc;
                  }, { kcal: 0, prot: 0, carb: 0, fat: 0 });

                  return (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', background: '#2c2c2c', padding: '15px', borderRadius: '8px', fontWeight: 'bold' }}>
                        <span style={{ color: '#ff9800' }}>🔥 {Math.round(totals.kcal)} kcal</span>
                        <span style={{ color: '#f44336' }}>🥩 {Math.round(totals.prot)}g</span>
                        <span style={{ color: '#4caf50' }}>🍞 {Math.round(totals.carb)}g</span>
                        <span style={{ color: '#ffeb3b' }}>🥑 {Math.round(totals.fat)}g</span>
                      </div>
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 25px 0', maxHeight: '200px', overflowY: 'auto' }}>
                        {items.map(item => (
                          <li key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #333' }}>
                            <span>{item.name || item.desc}</span>
                            <span style={{ color: '#aaa' }}>{item.qta || item.weight}g</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div style={{ marginBottom: '25px', fontSize: '1.1rem', lineHeight: '1.8' }}>
                <p style={{ margin: '5px 0' }}><strong>Attività:</strong> {selectedNodeReport.name || selectedNodeReport.desc || 'Allenamento'}</p>
                <p style={{ margin: '5px 0' }}><strong>Impatto:</strong> 🔥 {Math.round(selectedNodeReport.kcal || selectedNodeReport.cal || 0)} kcal bruciate</p>
                {selectedNodeReport.duration != null && <p style={{ margin: '5px 0' }}><strong>Durata:</strong> ⏱️ {Math.round(selectedNodeReport.duration * 60)} minuti</p>}
                {(selectedNodeReport.muscles || selectedNodeReport.workoutMuscles) && (selectedNodeReport.muscles || selectedNodeReport.workoutMuscles).length > 0 && (
                  <p style={{ margin: '5px 0', textTransform: 'capitalize' }}>
                    <strong>Muscoli target:</strong> 🦾 {(selectedNodeReport.muscles || selectedNodeReport.workoutMuscles).join(', ')}
                  </p>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '15px' }}>
              <button type="button" onClick={() => setSelectedNodeReport(null)} style={{ flex: 1, padding: '12px', background: '#444', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem' }}>
                Chiudi
              </button>
              <button type="button" onClick={() => {
                const node = selectedNodeReport;
                setSelectedNodeReport(null);
                if (node.type === 'meal') {
                  loadMealToConstructor(node.id);
                  setDrawerMealTime(node.time ?? 12);
                  setDrawerMealTimeStr(decimalToTimeStr(node.time ?? 12));
                  setIsDrawerOpen(true);
                } else {
                  setEditingWorkoutId(node.id);
                  setWorkoutType(node.subType || (node.type === 'work' ? 'lavoro' : 'pesi'));
                  setWorkoutStartTime(node.time ?? 12);
                  setWorkoutEndTime((node.time ?? 12) + (node.duration ?? 1));
                  setWorkoutKcal(node.kcal || node.cal || 300);
                  setWorkoutMuscles(Array.isArray(node.muscles) ? [...node.muscles] : (Array.isArray(node.workoutMuscles) ? [...node.workoutMuscles] : []));
                  setActiveAction('allenamento');
                  setIsDrawerOpen(true);
                }
              }} style={{ flex: 1, padding: '12px', background: '#00e5ff', color: '#000', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem' }}>
                ✏️ Modifica
              </button>
            </div>
          </div>
        </div>
      )}
      {showTelemetryPopup && (
        <div className="modal-overlay" onClick={() => setShowTelemetryPopup(false)} style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: '#1e1e1e', color: '#fff', padding: '25px', borderRadius: '16px', width: '100%', maxWidth: '420px', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '12px' }}>
              <h2 style={{ margin: 0, color: '#00e676', fontSize: '1.1rem' }}>📊 Telemetria</h2>
              <button type="button" onClick={() => setShowTelemetryPopup(false)} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: '5px', marginBottom: '20px', overflowX: 'auto', paddingBottom: '5px' }}>
              {['macro', 'bilanci', 'amino', 'vit', 'min', 'fat'].map(t => (
                <button key={t} type="button" onClick={() => setTelemetrySubTab(t)} style={{ padding: '8px 15px', fontSize: '0.7rem', background: telemetrySubTab === t ? '#00e676' : '#111', color: telemetrySubTab === t ? '#000' : '#888', border: 'none', borderRadius: '20px', textTransform: 'uppercase', whiteSpace: 'nowrap', cursor: 'pointer' }}>{t}</button>
              ))}
            </div>
            <div style={{ background: '#111', padding: '20px', borderRadius: '15px' }}>
              {telemetrySubTab === 'macro' && (<> {renderProgressBar('PROTEINE', totali.prot, userTargets.prot ?? TARGETS.macro.prot, 'g', 'prot')} {renderProgressBar('CARBOIDRATI', totali.carb, userTargets.carb ?? TARGETS.macro.carb, 'g', 'carb')} {renderProgressBar('GRASSI TOTALI', totali.fatTotal, userTargets.fatTotal ?? TARGETS.macro.fatTotal, 'g', 'fatTotal')} </>)}
              {telemetrySubTab === 'bilanci' && (
                <div className="view-animate">
                  <h4 style={{ fontSize: '0.7rem', color: '#b0bec5', letterSpacing: '1px', marginBottom: '15px' }}>RAPPORTI BIOCHIMICI</h4>
                  {renderRatioBar('Equilibrio Elettrolitico (Idratazione)', 'Sodio (Na)', totali?.na, 'Potassio (K)', totali?.k, 'Ideale: Na < K', (Number(totali?.na) || 0) < (Number(totali?.k) || 0))}
                  {renderRatioBar('Indice Infiammatorio (Grassi)', 'Omega 6', totali?.omega6, 'Omega 3', totali?.omega3, 'Ideale: W6:W3 < 4:1', (Number(totali?.omega6) || 0) <= (Number(totali?.omega3) || 1) * 4)}
                </div>
              )}
              {telemetrySubTab === 'amino' && (<> {Object.keys(TARGETS.amino).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.amino[k], 'mg', k))} </>)}
              {telemetrySubTab === 'vit' && (<> {Object.keys(TARGETS.vit).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.vit[k], k === 'vitA' || k === 'b9' ? 'µg' : 'mg', k))} </>)}
              {telemetrySubTab === 'min' && (<> {Object.keys(TARGETS.min).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.min[k], k === 'se' ? 'µg' : 'mg', k))} </>)}
              {telemetrySubTab === 'fat' && (<> {Object.keys(TARGETS.fat).map(k => renderProgressBar(k.toUpperCase(), totali[k] || 0, TARGETS.fat[k], 'g', k))} </>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}