import { test, expect } from '@playwright/test';
import { seedModulePermissions, grant, revoke } from './helpers';

test.beforeAll(async () => {
  await seedModulePermissions();
});

test.describe('Permissions tab', () => {
  test('alice sees all three modules in ws1', async ({ page }) => {
    await page.goto('/');
    // Alice is the default selected user
    await expect(page.getByText('Facturacion')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('RRHH')).toBeVisible();
    await expect(page.getByText('Reportes')).toBeVisible();
  });

  test('alice has read=YES on all modules', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Facturacion')).toBeVisible({ timeout: 8000 });
    // All 'read' badges on visible cards should show YES
    const readBadges = page.locator('code:text("read") + span');
    for (const badge of await readBadges.all()) {
      await expect(badge).toHaveText('YES');
    }
  });

  test('switching to carol shows Access Restricted', async ({ page }) => {
    await page.goto('/');
    // Select Carol in sidebar
    await page.getByText('Carol').click();
    await expect(page.getByText('Access Restricted')).toBeVisible({ timeout: 8000 });
  });

  test('switching to bob shows only facturacion in ws1', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Bob').click();
    await expect(page.getByText('Facturacion')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('RRHH')).not.toBeVisible();
    await expect(page.getByText('Reportes')).not.toBeVisible();
  });

  test('grant bob access to rrhh — module appears live without refresh', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Bob').click();
    // Confirm RRHH not visible yet
    await expect(page.getByText('Facturacion')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('RRHH')).not.toBeVisible();

    // Grant via worker API (simulates another user granting access)
    await grant('User:alice', 'viewer', 'Module', 'ws1_rrhh');

    // ZanzoPermServer DO broadcasts new snapshot — RRHH should appear without page reload
    await expect(page.getByText('RRHH')).toBeVisible({ timeout: 10000 });

    // Cleanup
    await revoke('User:alice', 'viewer', 'Module', 'ws1_rrhh');
  });

  test('workspace 2 shows alice modules', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Facturacion')).toBeVisible({ timeout: 8000 });
    await page.getByText('Workspace 2').click();
    await expect(page.getByText('Facturacion')).toBeVisible({ timeout: 5000 });
  });
});
