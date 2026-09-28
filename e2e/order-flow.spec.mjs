/**
 * Test de bout en bout contre l'environnement de test isolé
 * (dépôt -Mvp-staging, base Supabase kkhlpeqherxfdnilewkp) - plus
 * la production. "Resto Démo" (slug demo-charge) y existe en miroir
 * du même resto sur la vraie base, sans aucun impact sur les
 * données réelles quel que soit le nombre de passages.
 */
import { test, expect } from '@playwright/test';

const DEMO_URL = 'https://mvpcommande.github.io/-Mvp-staging/?resto=demo-charge';

test('un client peut parcourir la carte, ajouter un article et passer commande', async ({ page }) => {
  await page.goto(DEMO_URL);

  // Vérification robuste d'abord (le nom du resto apparaît à
  // plusieurs endroits dès le chargement) avant celle, plus fine,
  // sur le rôle d'en-tête - pour isoler si l'échec vient du
  // chargement lui-même ou d'un sélecteur trop précis.
  await expect(page.getByText('FOODATOI Démo').first()).toBeVisible({
    timeout: 20000
  });

  await expect(
    page.getByRole('heading', { name: /Choisis/i })
  ).toBeVisible({ timeout: 10000 });

  const addButtons = page.locator('[data-add]');
  await expect(addButtons.first()).toBeVisible({ timeout: 10000 });
  await addButtons.first().click();

  // "Ajouter" sur une carte ouvre la fiche produit (choix éventuels
  // de viande/sauce), elle ne met rien au panier directement - il
  // faut confirmer dans la fiche, sinon la modale reste ouverte et
  // bloque tout clic suivant (c'est exactement ce qui a fait
  // échouer les 5 premiers passages : un clic sur "Ma commande" en
  // boucle derrière une fenêtre encore ouverte, jusqu'au délai).
  await page.locator('#confirm-add').click();

  // openCart() se déclenche déjà automatiquement après la
  // confirmation - un clic explicite ici tombait sur un tiroir déjà
  // ouvert et bloquait tout (le vrai blocage de cette itération).

  await page.getByLabel(/TON NOM/i).fill('Test E2E');
  await page.getByLabel(/TON TÉLÉPHONE/i).fill('0600000000');

  const timeInput = page.locator('input[name="pickupTime"]');
  if (await timeInput.count()) {
    await timeInput.fill('12:00');
  }

  await page.locator('#order-form button[type="submit"]').click();

  await expect(
    page.getByText(/FA-\d{6}-[A-Z0-9]{6}/)
  ).toBeVisible({ timeout: 15000 });
});

/**
 * Suppose que le resto demo-charge (staging) est configuré en
 * settings.delivery_mode = 'internal' - sinon le toggle
 * retrait/livraison n'apparaît jamais dans le formulaire et ce test
 * échoue dès le premier assert sur fulfillmentType. À configurer
 * côté Supabase staging avant de lancer ce test (pas fait depuis cet
 * environnement, qui n'a ni accès réseau à mvpcommande.github.io ni
 * accès à la base de test).
 */
test('un client en livraison interne voit l\'encart adresse et peut commander', async ({ page }) => {
  await page.goto(DEMO_URL);

  await expect(page.getByText('FOODATOI Démo').first()).toBeVisible({
    timeout: 20000
  });

  const addButtons = page.locator('[data-add]');
  await expect(addButtons.first()).toBeVisible({ timeout: 10000 });
  await addButtons.first().click();
  await page.locator('#confirm-add').click();

  await page.getByLabel(/TON NOM/i).fill('Test E2E Livraison');
  await page.getByLabel(/TON TÉLÉPHONE/i).fill('0600000000');

  await page.locator('input[name="fulfillmentType"][value="DELIVERY"]').check();

  await expect(
    page.locator('#delivery-address-fields')
  ).toBeVisible();

  await page.locator('input[name="deliveryStreet"]').fill('12 rue des Fleurs');
  await page.locator('input[name="deliveryPostalCode"]').fill('31000');
  await page.locator('input[name="deliveryCity"]').fill('Toulouse');

  const timeInput = page.locator('input[name="pickupTime"]');
  if (await timeInput.count()) {
    await timeInput.fill('20:00');
  }

  await page.locator('#order-form button[type="submit"]').click();

  await expect(
    page.getByText(/FA-\d{6}-[A-Z0-9]{6}/)
  ).toBeVisible({ timeout: 15000 });
});
