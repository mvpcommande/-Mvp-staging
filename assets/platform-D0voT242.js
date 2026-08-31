import{n as e,t}from"./styles-Cr99Y0ZV.js";import{c as n,s as r}from"./restaurantOwner-B6nuQ7cA.js";var i=document.querySelector(`#platform-root`),a=`loading`,o=``,s=[];async function c(){if(!e){a=`error`,o=`Supabase n’est pas configuré.`,u();return}let{data:{session:t}}=await e.auth.getSession();if(!t){a=`auth`,u();return}await l()}async function l(){a=`loading`,u();let{data:t,error:n}=await e.from(`restaurants`).select(`*`).eq(`is_active`,!1).order(`created_at`,{ascending:!0});if(n){console.error(`[FOODATOI platform]`,n),a=`auth`,o=`Accès refusé ou session expirée. Reconnectez-vous avec le compte plateforme.`,u();return}s=t??[],a=`dashboard`,u()}function u(){if(a===`loading`){i.innerHTML=`<div class="onboarding-shell"><p class="eyebrow">FOODATOI · PLATEFORME</p><h1>Chargement…</h1></div>`;return}if(a===`error`){i.innerHTML=`<div class="onboarding-shell"><p class="eyebrow">FOODATOI</p><h1>Erreur</h1><p>${t(o)}</p></div>`;return}if(a===`auth`){d();return}f()}function d(){i.innerHTML=`
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · PLATEFORME</p>
      <h1>Connexion</h1>
      ${o?`<p class="onboarding-error">${t(o)}</p>`:``}
      <form id="login-form" class="order-form">
        <label>EMAIL<input name="email" type="email" required autocomplete="email"></label>
        <label>MOT DE PASSE<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary full" type="submit">Se connecter →</button>
      </form>
    </div>
  `,document.querySelector(`#login-form`).onsubmit=async t=>{t.preventDefault();let n=Object.fromEntries(new FormData(t.currentTarget));o=``,a=`loading`,u();try{await r(e,n),await l()}catch(e){console.error(`[FOODATOI platform]`,e),a=`auth`,o=`Email ou mot de passe incorrect.`,u()}}}function f(){i.innerHTML=`
    <div class="onboarding-shell">
      <div class="onboarding-header">
        <div>
          <p class="eyebrow">FOODATOI · PLATEFORME</p>
          <h1>Restaurants en attente.</h1>
        </div>
        <button class="secondary" id="signout-btn" type="button">Se déconnecter</button>
      </div>

      ${s.length?`<div class="product-list">
              ${s.map(e=>`
                <div class="pending-row">
                  <div>
                    <strong>${t(e.name)}</strong>
                    <span>${t(e.sector||`—`)} · /?resto=${t(e.slug)}</span>
                    <span>${t(e.phone||`Pas de téléphone renseigné`)}</span>
                    <span>Créé le ${new Date(e.created_at).toLocaleDateString(`fr-FR`)}</span>
                  </div>
                  <div class="pending-actions">
                    <button class="primary" data-activate="${e.id}" type="button">Activer</button>
                    <button class="danger small" data-reject="${e.id}" type="button">Rejeter</button>
                  </div>
                </div>
              `).join(``)}
            </div>`:`<p class="muted">Aucun restaurant en attente pour le moment.</p>`}
    </div>
  `,document.querySelector(`#signout-btn`).onclick=async()=>{await n(e),a=`auth`,u()},document.querySelectorAll(`[data-activate]`).forEach(t=>{t.onclick=async()=>{t.disabled=!0;let{error:n}=await e.from(`restaurants`).update({is_active:!0,onboarding_status:`READY`}).eq(`id`,t.dataset.activate);if(n){console.error(`[FOODATOI platform]`,n),alert(`Impossible d’activer ce restaurant pour le moment.`),t.disabled=!1;return}s=s.filter(e=>e.id!==t.dataset.activate),u()}}),document.querySelectorAll(`[data-reject]`).forEach(t=>{t.onclick=async()=>{if(!confirm(`Supprimer définitivement ce restaurant en attente ?`))return;let{error:n}=await e.from(`restaurants`).delete().eq(`id`,t.dataset.reject);if(n){console.error(`[FOODATOI platform]`,n),alert(`Impossible de supprimer ce restaurant pour le moment.`);return}s=s.filter(e=>e.id!==t.dataset.reject),u()}})}c();