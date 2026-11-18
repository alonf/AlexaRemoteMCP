@description('Short lowercase name used as a prefix for every resource.')
@minLength(3)
@maxLength(16)
param namePrefix string

param location string = resourceGroup().location

@description('Linux runtime stack for the web app.')
param linuxFxVersion string = 'NODE|24-lts'

@description('App Service plan SKU. One instance only: the journal and session writer are single-process by design.')
param skuName string = 'B1'

@description('Entra tenant ID that owns the sign-in app registration (not a secret).')
param entraTenantId string

@description('Entra app registration (client) ID used for owner sign-in (not a secret).')
param entraClientId string

@description('Comma-separated approved MCP client redirect URIs for dynamic client registration.')
param approvedRedirectUris string

var suffix = uniqueString(resourceGroup().id, namePrefix)
var vaultName = take('${namePrefix}-kv-${suffix}', 24)
var siteName = '${namePrefix}-mcp-${suffix}'
var storageName = take('${namePrefix}st${suffix}', 24)
var secretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // built-in role ID "Key Vault Secrets Officer", not a secret // gitleaks:allow
var blobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // built-in role ID "Storage Blob Data Contributor", not a secret // gitleaks:allow

// Private storage for catalog backups; the app reaches it with its managed identity, never a key.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${namePrefix}-plan'
  location: location
  kind: 'linux'
  sku: { name: skuName, capacity: 1 }
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: siteName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      healthCheckPath: '/healthz'
      appCommandLine: 'node dist/src/server.js'
      appSettings: [
        { name: 'KEY_VAULT_URI', value: vault.properties.vaultUri }
        { name: 'PUBLIC_BASE_URL', value: 'https://${siteName}.azurewebsites.net' }
        { name: 'JOURNAL_PATH', value: '/home/data/journal.sqlite' }
        { name: 'ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'ENTRA_CLIENT_ID', value: entraClientId }
        { name: 'APPROVED_REDIRECT_URIS', value: approvedRedirectUris }
        { name: 'CATALOG_BACKUP_URL', value: storage.properties.primaryEndpoints.blob }
        // The owner ID and mutation allow-list are private and set after deployment, never in this file.
        { name: 'ENTRA_CLIENT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${vault.properties.vaultUri}secrets/entra-client-secret/)' }
      ]
    }
  }
}

resource siteIdentityRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, site.id, secretsOfficer)
  scope: vault
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficer)
  }
}

resource siteStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, site.id, blobContributor)
  scope: storage
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributor)
  }
}

output siteName string = site.name
output baseUrl string = 'https://${site.properties.defaultHostName}'
output vaultName string = vault.name
