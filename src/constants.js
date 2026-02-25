export const MEALS = ['Merenda AM', 'Pranzo', 'Merenda PM', 'Cena'];
export const MEAL_KEYS = ['merenda1', 'pranzo', 'merenda2', 'cena'];

export const MACRO_KEYS = ['kcal', 'prot', 'carb', 'fat', 'fibre'];

export const SYNC_BAND = 10;      // ±10% = neon azzurro (in sync)
export const MODERATE_BAND = 25;  // fino ±25% = giallo
// >25% = rosso critico

export const COLORS = {
  sync: '#00ffcc',
  syncGlow: '0 0 12px #00ffcc, 0 0 24px rgba(0,255,204,0.5)',
  moderate: '#ffd54f',
  critical: '#ff5252',
  zeroLine: 'rgba(255,255,255,0.6)',
  background: '#121212',
};

export const MESSAGES = {
  inSync: ['Sei in scia!', 'Ghost Sync perfetto!', 'In linea con il Ghost!'],
  moderate: ['Piccolo aggiustamento e sei a posto.', 'Quasi in scia!'],
  critical: ['Recupera il Ghost!', 'Ricalibra al prossimo pasto.'],
};

export const AMINO_KEYS = ['leucina', 'isoleucina', 'valina'];
