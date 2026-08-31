/**
 * Compresse une image côté client avant envoi, pour ne jamais
 * envoyer une photo de téléphone brute (souvent 3-8 Mo) vers le
 * stockage. Redimensionne au maximum nécessaire pour un affichage
 * carte/logo (bien au-delà de ce qui s'affiche jamais en pratique,
 * marge gardée pour les écrans haute densité), réexporte en JPEG à
 * une qualité qui reste visuellement proche de l'original.
 *
 * Repose sur Canvas, donc dépend du navigateur - pas testable
 * unitairement en Node comme le reste, seule la validation des
 * paramètres l'est.
 */
export function resolveCompressionOptions(kind) {
  if (kind === 'logo') {
    return { maxDimension: 600, quality: 0.9 };
  }
  return { maxDimension: 1600, quality: 0.85 };
}

export async function compressImage(file, kind = 'product') {
  const { maxDimension, quality } = resolveCompressionOptions(kind);

  if (!file.type.startsWith('image/')) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    maxDimension / Math.max(bitmap.width, bitmap.height)
  );

  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );

  // Si la compression échoue ou produit un résultat plus lourd que
  // l'original (rare, mais possible sur une image déjà très légère),
  // on garde l'original plutôt que de risquer un envoi cassé.
  if (!blob || blob.size >= file.size) {
    return file;
  }

  return new File(
    [blob],
    file.name.replace(/\.\w+$/, '.jpg'),
    { type: 'image/jpeg' }
  );
}
