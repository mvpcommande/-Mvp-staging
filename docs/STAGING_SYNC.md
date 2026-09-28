# Synchronisation staging ← production

Ce dépôt (`mvpcommande/-Mvp-staging`) est l'environnement de test isolé de
FOODATOI. Son code applicatif suit celui de production
(`mvpcommande/Mvp-`), mais **il ne partage jamais ses secrets, sa base
Supabase ni son domaine**.

## Dernière synchronisation

| | |
|---|---|
| Source | `mvpcommande/Mvp-` `main` @ `3583bb4012192b3811f8740d22520194343f3fcb` ("Bloc 5.4 : fiabilise le Realtime comptoir") |
| Staging avant | `1776dd5f0746c1fe494d87b3f60dd7b1f9e620a9` |
| Méthode | `git archive` de l'arbre prod, puis réapplication des divergences ci-dessous |

## Divergences volontaires (à préserver à chaque synchro)

| Fichier | Prod | Staging | Pourquoi |
|---|---|---|---|
| `.github/workflows/ci.yml` | présent | **absent** | Déploie avec les identifiants Supabase **prod** et le domaine `www.foodatoi.fr`. |
| `.github/workflows/health-check.yml` | présent | **absent** | Sonde la production toutes les 2 h. |
| `.github/workflows/deploy.yml` | absent | présent | Build avec le projet Supabase **de test** (`kkhlpeqherxfdnilewkp`), base `/-Mvp-staging/`. |
| `public/CNAME` | `www.foodatoi.fr` | **absent** | Le staging ne doit jamais revendiquer le domaine de production sur GitHub Pages. |
| `counterLoad.js` | URL + clé publishable prod en dur | `import.meta.env.VITE_SUPABASE_*` | Sinon la page `counter.html` du staging lit la base prod. |
| `onboarding.js` (`SUMUP_REDIRECT_URI`) | callback Edge Function prod en dur | dérivée de `VITE_SUPABASE_URL` | Sinon un test OAuth SumUp en staging écrirait des tokens dans la base prod. NB : cette URI doit être déclarée côté SumUp pour que le flux aboutisse en staging ; tant qu'elle ne l'est pas, le flux échoue (comportement sûr). |

Les deux derniers changements sont neutres en production (même valeur
résolue) et pourraient être remontés dans `Mvp-` pour supprimer la
divergence — décision laissée au propriétaire du repo prod (ce bloc ne
touche pas la production).

## Procédure de re-synchronisation

```bash
# depuis un clone propre des deux dépôts
cd Mvp- && git archive origin/main | tar -x -C ../-Mvp-staging \
  --exclude=.github/workflows/ci.yml \
  --exclude=.github/workflows/health-check.yml \
  --exclude=public/CNAME
cd ../-Mvp-staging
git diff counterLoad.js onboarding.js   # réappliquer les 2 adaptations si écrasées
grep -rn "ffuykessameuonpnyiyc\|sb_publishable_MIwz" --exclude-dir=node_modules . \
  | grep -v "^./supabase/migrations\|^./README-DSI.md\|^./docs/"   # doit être vide
npm ci && npm test && npm run build
```

Les migrations SQL versionnées sont synchronisées comme du code : **les
appliquer sur la base staging reste une action manuelle et explicite**,
jamais un effet de bord de la synchronisation.
