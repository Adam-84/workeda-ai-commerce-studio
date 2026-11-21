# Phase 6 — Integration Center : DSers et 17TRACK en lecture seule

## Résumé
- Connecteurs **DSers** (MCP, OAuth 2.1 + PKCE, six portées de lecture) et **17TRACK** (clé existante), **strictement en lecture seule** : liste blanche d'outils appliquée avant tout réseau (12 outils DSers, 3 endpoints 17TRACK ; écriture, commande, paiement et `register` payant refusés).
- **Réseau réel verrouillé** (`ARCHIPEL_ALLOW_REAL_NETWORK=1` requis) : aucun compte contacté par cette PR.
- Quotas configurables (DSers 100/jour), cache, pause sur 429, appels sérialisés.
- Secrets : DPAPI (Windows) / AES-256-GCM, jamais en clair ni dans git.
- Confidentialité : projection par liste blanche excluant les champs clients structurés, suivis masqués, e-mails/téléphones/suivis et formes de secrets reconnues neutralisés dans les champs libres du catalogue, provenance des résultats hors journal git. Les noms et adresses éventuellement présents dans les textes commerciaux sont conservés.
- Interface **Integrations** (design Archipel existant), accès par agent (aucun par défaut), révocation.
- Migration comm v3 (`with_integrations`), routes `/api/integrations/*` locales.

## Tests
`node --test` : **442 réussis, 0 échec** (439 précédents + 3 régressions ; serveurs DSers/17TRACK simulés). Revue de sécurité indépendante Codex (plusieurs passes), correctifs et régressions inclus.

## Limites connues
Formats de réponse DSers à confirmer à la première connexion réelle ; détection des coordonnées et secrets heuristique ; anciens caches Shopify filtrés à la lecture sans purge rétroactive des archives locales ; lecteur d'écran non testé. Détails : `docs/INTEGRATIONS.md`.

## À faire avant usage réel
Vérifier l'abonnement DSers (MCP : Advanced/Pro/Enterprise) ; ne définir `ARCHIPEL_ALLOW_REAL_NETWORK=1` qu'avec votre accord.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
