# Ghost Mode Dashboard

Modulo React gamificato per la visualizzazione dell’aderenza nutrizionale giornaliera con focus sul controllo del cortisolo.

## Installazione

```bash
npm install
```

## Avvio

```bash
npm run dev
```

Apri `http://localhost:5173`.

## Struttura dati `mealsData`

Passa a `<GhostModeDashboard mealsData={...} />` un oggetto con chiavi `merenda1`, `pranzo`, `merenda2`, `cena`. Per ogni pasto:

- **target**: strategia Ghost `{ kcal, prot, carb, fat, fibre }`
- **real**: consumo utente `{ kcal, prot, carb, fat, fibre }`

Lo **scostamento % calorico** è `((Real.kcal - Target.kcal) / Target.kcal) * 100`, limitato tra -40% e +40% nel grafico.

## Funzionalità

- **Grafico a linea (Recharts)**: asse X = 4 pasti, asse Y = -40% … +40%, linea tratteggiata a 0 (Ghost Sync). Punti cliccabili con colore in base a scostamento (neon sync ±10%, giallo moderato, rosso critico).
- **Sync Score**: media dell’aderenza dei 4 pasti; colore dinamico e messaggio motivazionale.
- **InsightCard** (pop-up al click su un punto): diagnosi macro (e.g. Eccesso Proteico, Carenza Carboidrati), spiegazione cortisolo/stabilità glicemica, azione correttiva, Food Tip da database.
- **Database**: hook `useGoldStandard` legge `public/crea_gold_standard.json` per i Food Tip (profili con minerali, es. Magnesio). Puoi sostituire il file con il tuo CREA gold standard.

## File principali

- `src/GhostModeDashboard.jsx` – dashboard, grafico, stato
- `src/InsightCard.jsx` – pop-up insight con diagnosi, cortisolo, azione, food tip
- `src/useGoldStandard.js` – hook per `crea_gold_standard.json` e `getTipsByMineral()`
- `public/crea_gold_standard.json` – esempio alimenti (nome, kcal, prot, carb, mg, minerali)
