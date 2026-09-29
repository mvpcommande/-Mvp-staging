// Import de menu (PDF/photo) -> extraction IA -> relecture humaine -> carte.
// UI construite en createElement (pas d'innerHTML) : sûr, compatible CSP.

const BUCKET = 'restaurant-media';

function euros(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) {
    if (c) node.append(c);
  }
  return node;
}

export function setupMenuImport({ supabase, restaurant, onImported }) {
  const fileInput = document.querySelector('#menu-import-file');
  const reviewBox = document.querySelector('#menu-import-review');
  const status = document.querySelector('#menu-import-status');
  if (!fileInput || !reviewBox || !restaurant) return;

  const setStatus = (msg) => {
    status.textContent = msg || '';
  };

  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    reviewBox.replaceChildren();

    if (file.size > 10 * 1024 * 1024) {
      setStatus('Fichier trop lourd (max 10 Mo).');
      return;
    }
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const ext = isPdf ? 'pdf' : (/\.png$/i.test(file.name) ? 'png' : 'jpg');
    const path = `${restaurant.id}/menu-imports/${Date.now()}.${ext}`;

    setStatus('Envoi du fichier…');
    try {
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { upsert: false });
      if (upErr) throw upErr;

      const { data: imp, error: impErr } = await supabase
        .from('menu_imports')
        .insert({
          restaurant_id: restaurant.id,
          source_type: isPdf ? 'pdf' : 'image',
          storage_path: path,
          status: 'PENDING'
        })
        .select('id')
        .single();
      if (impErr) throw impErr;

      setStatus('Lecture du menu par l’IA… (quelques secondes)');
      const { data, error: fnErr } = await supabase.functions.invoke('parse-menu', {
        body: { import_id: imp.id }
      });
      if (fnErr || !data || !Array.isArray(data.products)) {
        throw fnErr || new Error('extraction impossible');
      }

      setStatus('');
      renderReview(data.products, imp.id);
    } catch (err) {
      console.error('[FOODATOI onboarding] import menu', err);
      setStatus('Impossible de lire ce menu. Réessayez avec un PDF ou une photo nette.');
    } finally {
      fileInput.value = '';
    }
  };

  function renderReview(products, importId) {
    reviewBox.replaceChildren();
    if (!products.length) {
      setStatus('Aucun produit détecté. Réessayez avec un document plus lisible.');
      return;
    }

    const rows = [];
    const intro = el('p', {
      className: 'menu-import-intro',
      textContent: `${products.length} produits détectés. Vérifiez et corrigez avant d’ajouter à votre carte.`
    });

    const list = el('div', { className: 'menu-import-rows' });
    products.forEach((p) => {
      const name = el('input', { value: p.name || '', placeholder: 'Nom' });
      const category = el('input', { value: p.category || '', placeholder: 'Catégorie' });
      const price = el('input', {
        value: euros(p.price_cents), type: 'number', step: '0.01', min: '0', placeholder: 'Prix €'
      });
      const desc = el('input', { value: p.description || '', placeholder: 'Description (optionnel)' });
      const remove = el('button', { type: 'button', className: 'menu-import-remove', textContent: '✕' });
      const row = el('div', { className: 'menu-import-row' }, [name, category, price, desc, remove]);
      const entry = { name, category, price, desc, row };
      remove.onclick = () => { row.remove(); entry.removed = true; };
      rows.push(entry);
      list.append(row);
    });

    const confirm = el('button', {
      type: 'button', className: 'primary full', textContent: 'Ajouter ces produits à ma carte'
    });
    confirm.onclick = async () => {
      confirm.disabled = true;
      const payload = rows
        .filter((r) => !r.removed && r.name.value.trim())
        .map((r) => ({
          name: r.name.value.trim(),
          category: r.category.value.trim() || 'Autre',
          price_cents: Math.round(parseFloat(r.price.value || '0') * 100),
          description: r.desc.value.trim() || null
        }));
      if (!payload.length) { confirm.disabled = false; return; }
      try {
        const { data: count, error } = await supabase.rpc('import_products_from_payload', {
          p_products: payload,
          p_import_id: importId
        });
        if (error) throw error;
        reviewBox.replaceChildren();
        setStatus(`${count} produits ajoutés à votre carte ✓`);
        if (typeof onImported === 'function') await onImported();
      } catch (err) {
        console.error('[FOODATOI onboarding] import confirm', err);
        setStatus('Impossible d’ajouter les produits pour le moment.');
        confirm.disabled = false;
      }
    };

    reviewBox.append(intro, list, confirm);
  }
}
