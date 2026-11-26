const daily = (time) => ({ kind: 'time', schedule: { kind: 'daily', time, zone: 'Europe/Paris' } });
export const AUTOMATION_TEMPLATES = [
  ['noah', 'Veille concurrentielle', ['competitor'], 'Comparer les prix concurrents issus de relevés structurés comparables. Signaler toute source manquante.'],
  ['sophia', 'Tendances du marché', ['recommendations'], 'Synthétiser les observations sourcées disponibles ; aucune tendance mesurée sans source.'],
  ['lucas', 'Audit du catalogue', ['catalog'], 'Auditer la complétude et les changements du catalogue accessible.'],
  ['isabella', 'Prix et coûts connus', ['shopify_admin', 'manual_import'], 'Comparer prix et coûts unitaires identifiés, même devise. Frais ou taxes absents inconnus. Proposer sans modifier les prix.'],
  ['maxime', 'Audit des applications', ['shopify_apps'], 'Analyser les applications déclarées, coûts connus et chevauchements fonctionnels. Toute suppression exige validation humaine.'],
  ['chloe', 'UX et conversion', ['catalog'], 'Proposer des hypothèses UX sur le catalogue accessible ; ne pas inventer de sessions ou de taux de conversion.'],
  ['benjamin', 'Reporting commercial', ['shopify_admin'], 'Préparer un reporting des seuls indicateurs agrégés accessibles ; signaler les ventes et KPI absents.'],
  ['alexander', 'Synthèse stratégique', ['recommendations'], 'Synthétiser les recommandations disponibles sans relancer les autres agents ; conserver la validation humaine.'],
  ['olivia', 'Suivi des missions', ['missions'], 'Repérer les missions terminées, en échec ou à suivre, sans créer de boucle de délégation.'],
  ['harper', 'Contrôle qualité', ['catalog'], 'Relever les anomalies de qualité dans les données disponibles et citer leurs dates.']
].map(([agentSlug, name, sources, objective]) => ({ name, agentSlug, sources, objective, trigger: daily('09:00'), allowAi: false, perDay: 5, freshnessMinutes: 1440, cooldownMinutes: 60 }));
