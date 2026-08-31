import{n as e,t}from"./styles-Dmypx1fe.js";import{t as n}from"./errorLog-DYeNOlWf.js";import{a as r,c as i,d as a,f as o,h as s,i as c,l,m as u,n as d,o as f,p,r as m,s as h,t as g,u as _}from"./restaurantOwner-B6nuQ7cA.js";function v(e){return e===`logo`?{maxDimension:600,quality:.9}:{maxDimension:1600,quality:.85}}async function y(e,t=`product`){let{maxDimension:n,quality:r}=v(t);if(!e.type.startsWith(`image/`))return e;let i=await createImageBitmap(e),a=Math.min(1,n/Math.max(i.width,i.height)),o=Math.round(i.width*a),s=Math.round(i.height*a),c=document.createElement(`canvas`);c.width=o,c.height=s,c.getContext(`2d`).drawImage(i,0,0,o,s),i.close();let l=await new Promise(e=>c.toBlob(e,`image/jpeg`,r));return!l||l.size>=e.size?e:new File([l],e.name.replace(/\.\w+$/,`.jpg`),{type:`image/jpeg`})}var b=document.querySelector(`#onboarding-root`),x=[[`pizza`,`Pizza`],[`kebab`,`Kebab`],[`burger`,`Burger`],[`restaurant`,`Restaurant`],[`snack`,`Snack`],[`boulangerie`,`Boulangerie`],[`sushi`,`Sushi`],[`other`,`Autre`]],S=[[`mon`,`Lundi`],[`tue`,`Mardi`],[`wed`,`Mercredi`],[`thu`,`Jeudi`],[`fri`,`Vendredi`],[`sat`,`Samedi`],[`sun`,`Dimanche`]],C=`loading`,w=`signup`,T=``,E=null,D={},O=[];function k(){return`${window.location.protocol}//${window.location.host}`}function A(){return`${k()}/?resto=${E.slug}`}function j(){return`${k()}/admin.html?resto=${E.slug}`}async function M(){if(!e){C=`error`,T=`Supabase n’est pas configuré.`,P();return}let{data:{session:t}}=await e.auth.getSession();if(!t){C=`auth`,P();return}await N()}async function N(){C=`loading`,P();try{if(E=await r(e),!E){C=`create`,P();return}D=E.settings?.opening_hours||{},O=await c(e,E.id),C=`dashboard`}catch(e){console.error(`[FOODATOI onboarding]`,e),T=`Impossible de charger votre espace pour le moment.`,C=`error`}P()}function P(){if(C===`loading`){b.innerHTML=`<div class="onboarding-shell"><p class="eyebrow">FOODATOI</p><h1>Chargement…</h1></div>`;return}if(C===`error`){b.innerHTML=`
      <div class="onboarding-shell">
        <p class="eyebrow">FOODATOI</p>
        <h1>Un problème est survenu.</h1>
        <p>${t(T)}</p>
      </div>
    `;return}if(C===`auth`){F();return}if(C===`create`){I();return}L()}function F(){let n=w===`signup`;b.innerHTML=`
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · ESPACE RESTAURATEUR</p>
      <h1>${n?`Créer mon restaurant`:`Se connecter`}</h1>
      <p class="onboarding-lede">
        Créez votre espace, configurez votre carte et récupérez vos
        liens de commande et de comptoir en quelques minutes.
      </p>

      ${T?`<p class="onboarding-error">${t(T)}</p>`:``}

      <form id="auth-form" class="order-form">
        <label>
          EMAIL
          <input name="email" type="email" required autocomplete="email">
        </label>
        <label>
          MOT DE PASSE
          <input name="password" type="password" required minlength="6" autocomplete="${n?`new-password`:`current-password`}">
        </label>
        <button class="primary full" type="submit">
          ${n?`Créer mon compte →`:`Se connecter →`}
        </button>
      </form>

      <button class="secondary full" id="toggle-auth-mode" type="button">
        ${n?`J’ai déjà un compte`:`Créer un compte`}
      </button>
    </div>
  `,document.querySelector(`#toggle-auth-mode`).onclick=()=>{w=n?`login`:`signup`,T=``,P()},document.querySelector(`#auth-form`).onsubmit=async t=>{t.preventDefault();let r=Object.fromEntries(new FormData(t.currentTarget));if(!f(r.email)){T=`Adresse email invalide.`,P();return}T=``,C=`loading`,P();try{if(n){if((await l(e,r)).pendingConfirmation){C=`auth`,T=`Compte créé ! Vérifiez vos emails pour confirmer votre adresse avant de vous connecter.`,w=`login`,P();return}}else await h(e,r);await N()}catch(e){console.error(`[FOODATOI onboarding]`,e),C=`auth`,T=String(e?.message||``).includes(`Invalid login credentials`)?`Email ou mot de passe incorrect.`:String(e?.message||``).includes(`already registered`)?`Un compte existe déjà avec cet email.`:`Impossible de traiter la demande pour le moment.`,P()}}}function I(){b.innerHTML=`
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · ÉTAPE 1</p>
      <h1>Votre restaurant</h1>
      <p class="onboarding-lede">
        Quelques infos de base pour créer votre espace. Vous
        pourrez tout modifier ensuite.
      </p>

      ${T?`<p class="onboarding-error">${t(T)}</p>`:``}

      <form id="create-form" class="order-form">
        <label>
          NOM DU RESTAURANT
          <input name="name" id="create-name" required autocomplete="organization">
        </label>

        <label>
          ADRESSE DE VOTRE ESPACE
          <div class="slug-preview">
            foodatoi.fr/?resto=<span id="slug-preview-text">votre-restaurant</span>
          </div>
          <input name="slug" id="create-slug" required>
        </label>

        <label>
          TYPE D'ÉTABLISSEMENT
          <select name="sector" required>
            ${x.map(([e,n])=>`<option value="${e}">${t(n)}</option>`).join(``)}
          </select>
        </label>

        <label>
          TÉLÉPHONE (facultatif)
          <input name="phone" inputmode="tel" autocomplete="tel">
        </label>

        <label>
          ADRESSE (facultatif)
          <input name="addressStreet" placeholder="Rue" autocomplete="street-address">
        </label>
        <div class="form-grid">
          <label>
            CODE POSTAL
            <input name="addressPostalCode" inputmode="numeric">
          </label>
          <label>
            VILLE
            <input name="addressCity" autocomplete="address-level2">
          </label>
        </div>

        <button class="primary full" type="submit">
          Créer mon restaurant →
        </button>
      </form>
    </div>
  `;let n=document.querySelector(`#create-name`),r=document.querySelector(`#create-slug`),i=document.querySelector(`#slug-preview-text`),a=!1;n.oninput=()=>{a||(r.value=_(n.value),i.textContent=r.value||`votre-restaurant`)},r.oninput=()=>{a=!0,r.value=_(r.value),i.textContent=r.value||`votre-restaurant`},document.querySelector(`#create-form`).onsubmit=async t=>{t.preventDefault();let n=Object.fromEntries(new FormData(t.currentTarget));T=``,C=`loading`,P();try{await d(e,n),await N()}catch(e){console.error(`[FOODATOI onboarding]`,e),C=`create`,T=String(e?.message||``).includes(`SLUG_ALREADY_TAKEN`)?`Cette adresse est déjà prise, choisissez-en une autre.`:`Impossible de créer le restaurant pour le moment.`,P()}}}function L(){b.innerHTML=`
    <div class="onboarding-shell">
      <div class="onboarding-header">
        <div>
          <p class="eyebrow">FOODATOI · ${t(E.name)}</p>
          <h1>Votre espace.</h1>
        </div>
        <button class="secondary" id="signout-btn" type="button">Se déconnecter</button>
      </div>

      <section class="links-card">
        <p class="eyebrow">VOS LIENS</p>

        <div class="link-row">
          <div>
            <strong>Lien de commande</strong>
            <span>À partager avec vos clients (Facebook, flyers…)</span>
            <code>${t(A())}</code>
          </div>
          <button class="primary copy-btn" data-copy="${t(A())}" type="button">
            Copier
          </button>
        </div>

        <div class="link-row">
          <div>
            <strong>Lien comptoir</strong>
            <span>Gardez-le pour vous et votre équipe uniquement</span>
            <code>${t(j())}</code>
          </div>
          <button class="primary copy-btn" data-copy="${t(j())}" type="button">
            Copier
          </button>
        </div>

        ${E.is_active?``:`
              <p class="onboarding-note">
                Votre espace est prêt à être configuré. Un dernier
                contrôle de notre équipe avant la mise en ligne
                publique (généralement sous 24h) — vous pouvez
                déjà tout préparer ci-dessous.
              </p>
            `}
      </section>

      <section class="onboarding-section">
        <h2>Identité visuelle</h2>
        <div class="identity-row">
          <div class="identity-logo-preview">
            ${E.logo_url?`<img src="${t(E.logo_url)}" alt="">`:`<span>${t((E.name||`?`).slice(0,2).toUpperCase())}</span>`}
          </div>
          <label class="secondary" id="logo-upload-label">
            ${E.logo_url?`Changer le logo`:`Ajouter un logo`}
            <input type="file" id="logo-input" accept="image/jpeg,image/png,image/webp" hidden>
          </label>
        </div>
        <label class="color-picker-row">
          COULEUR PRINCIPALE
          <input type="color" id="color-input" value="${t(E.primary_color||`#e84d27`)}">
        </label>
      </section>

      <section class="onboarding-section">
        <h2>Horaires d'ouverture</h2>
        <form id="hours-form">
          ${S.map(([e,t])=>{let n=D[e]||[],r=n.length>0,i=n[0]||[`11:30`,`14:00`],a=n[1]||[`18:30`,`22:00`];return`
              <div class="hours-row" data-day="${e}">
                <label class="account-toggle">
                  <input type="checkbox" class="day-open" ${r?`checked`:``}>
                  ${t}
                </label>
                <div class="hours-inputs" ${r?``:`style="display:none"`}>
                  <input type="time" class="r1-start" value="${i[0]}">
                  <input type="time" class="r1-end" value="${i[1]}">
                  <label class="account-toggle small">
                    <input type="checkbox" class="has-r2" ${n[1]?`checked`:``}>
                    2e créneau
                  </label>
                  <div class="hours-inputs r2" ${n[1]?``:`style="display:none"`}>
                    <input type="time" class="r2-start" value="${a[0]}">
                    <input type="time" class="r2-end" value="${a[1]}">
                  </div>
                </div>
              </div>
            `}).join(``)}
          <button class="primary" type="submit">Enregistrer les horaires</button>
          <span id="hours-saved" class="onboarding-saved hidden">Enregistré ✓</span>
        </form>
      </section>

      <section class="onboarding-section">
        <h2>Votre carte (${O.length})</h2>

        <div class="product-list">
          ${O.length?O.map(e=>{let n=(e.product_images||[]).length>0;return`
                    <div class="product-row">
                      <div class="product-row-main">
                        <strong>${t(e.name)}</strong>
                        <span>${t(e.category)} · ${(e.price_cents/100).toFixed(2)} €</span>
                      </div>
                      <div class="product-row-actions">
                        ${n?`<span class="photo-ok">Photo ✓</span>`:`
                              <label class="photo-upload-btn">
                                Ajouter une photo
                                <input type="file" accept="image/jpeg,image/png,image/webp" class="photo-input" data-product="${e.id}" hidden>
                              </label>
                            `}
                        <label class="account-toggle small">
                          <input type="checkbox" class="product-active" data-id="${e.id}" ${e.is_active?`checked`:``}>
                          Actif
                        </label>
                        <button class="danger small" data-delete="${e.id}" type="button">Supprimer</button>
                      </div>
                    </div>
                  `}).join(``):`<p class="muted">Aucun produit pour le moment.</p>`}
        </div>

        <h3>Ajouter un produit</h3>
        <form id="product-form" class="order-form">
          <label>
            NOM
            <input name="name" required>
          </label>
          <div class="form-grid">
            <label>
              CATÉGORIE
              <input name="category" placeholder="Ex: Burgers" required>
            </label>
            <label>
              PRIX (€)
              <input name="price" type="number" step="0.01" min="0" required>
            </label>
          </div>
          <label>
            DESCRIPTION (facultatif)
            <input name="description">
          </label>
          <label>
            PHOTO (facultatif)
            <input name="photo" type="file" accept="image/jpeg,image/png,image/webp">
          </label>
          <label class="account-toggle"><input type="checkbox" name="meat">Choix de viande</label>
          <label class="account-toggle"><input type="checkbox" name="sauce">Choix de sauce</label>
          <label class="account-toggle"><input type="checkbox" name="drink">Boisson incluse</label>
          <button class="primary full" type="submit">Ajouter le produit</button>
        </form>
      </section>
    </div>
  `,R()}function R(){document.querySelector(`#signout-btn`).onclick=async()=>{await i(e),E=null,C=`auth`,w=`login`,P()},document.querySelectorAll(`.copy-btn`).forEach(e=>{e.onclick=()=>{navigator.clipboard.writeText(e.dataset.copy).then(()=>{let t=e.textContent;e.textContent=`Copié ✓`,setTimeout(()=>{e.textContent=t},1500)})}}),document.querySelectorAll(`.hours-row`).forEach(e=>{let t=e.querySelector(`.day-open`),n=e.querySelector(`.hours-inputs`),r=e.querySelector(`.has-r2`),i=e.querySelector(`.r2`);t.onchange=()=>{n.style.display=t.checked?``:`none`},r.onchange=()=>{i.style.display=r.checked?``:`none`}}),document.querySelector(`#hours-form`).onsubmit=async t=>{t.preventDefault();let n={};document.querySelectorAll(`.hours-row`).forEach(e=>{let t=e.dataset.day;if(!e.querySelector(`.day-open`).checked){n[t]=[];return}let r=[[e.querySelector(`.r1-start`).value,e.querySelector(`.r1-end`).value]];e.querySelector(`.has-r2`).checked&&r.push([e.querySelector(`.r2-start`).value,e.querySelector(`.r2-end`).value]),n[t]=r});try{await o(e,E.id,n),D=n;let t=document.querySelector(`#hours-saved`);t.classList.remove(`hidden`),setTimeout(()=>t.classList.add(`hidden`),2e3)}catch(e){console.error(`[FOODATOI onboarding]`,e),alert(`Impossible d’enregistrer les horaires pour le moment.`)}},document.querySelectorAll(`.product-active`).forEach(t=>{t.onchange=async()=>{try{await a(e,t.dataset.id,t.checked)}catch(e){console.error(`[FOODATOI onboarding]`,e),t.checked=!t.checked}}}),document.querySelectorAll(`[data-delete]`).forEach(t=>{t.onclick=async()=>{if(confirm(`Supprimer ce produit ?`))try{await m(e,t.dataset.delete),O=O.filter(e=>e.id!==t.dataset.delete),P()}catch(e){console.error(`[FOODATOI onboarding]`,e),alert(`Impossible de supprimer ce produit pour le moment.`)}}}),document.querySelector(`#color-input`).onchange=async t=>{try{await p(e,E.id,t.target.value),E.primary_color=t.target.value}catch(e){console.error(`[FOODATOI onboarding]`,e),alert(`Impossible d’enregistrer la couleur pour le moment.`)}},document.querySelector(`#logo-input`).onchange=async t=>{let n=t.target.files[0];if(!n)return;let r=document.querySelector(`#logo-upload-label`),i=r.firstChild.textContent;r.firstChild.textContent=`Envoi…`;try{let t=await y(n,`logo`);E.logo_url=await s(e,E.id,t),P()}catch(e){console.error(`[FOODATOI onboarding]`,e),alert(`Impossible d’envoyer le logo pour le moment.`),r.firstChild.textContent=i}},document.querySelectorAll(`.photo-input`).forEach(t=>{t.onchange=async()=>{let r=t.files[0];if(!r)return;let i=t.closest(`.photo-upload-btn`);i.textContent=`Envoi…`;try{let n=await y(r,`product`);await u(e,E.id,t.dataset.product,n),O=await c(e,E.id),P()}catch(t){console.error(`[FOODATOI onboarding]`,t),n(e,{restaurantId:E?.id,context:`onboarding.uploadProductPhoto`,message:t?.message??String(t),page:`onboarding`}),alert(`Impossible d’envoyer cette photo pour le moment.`),i.textContent=`Ajouter une photo`}}}),document.querySelector(`#product-form`).onsubmit=async t=>{t.preventDefault();let r=t.currentTarget,i=Object.fromEntries(new FormData(r)),a=r.photo.files[0];try{let t=await g(e,E.id,i);if(a){let n=await y(a,`product`);await u(e,E.id,t.id,n)}O=await c(e,E.id),P()}catch(t){console.error(`[FOODATOI onboarding]`,t),n(e,{restaurantId:E?.id,context:`onboarding.addProduct`,message:t?.message??String(t),page:`onboarding`}),alert(`Impossible d’ajouter ce produit pour le moment.`)}}}M();