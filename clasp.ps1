# clasp.ps1 - auto-selects clasp credentials for this app.
# Reads the account name from .clasp-account and forwards all args to clasp
# using the named user, so multi-account setups never push with the wrong login.
# Register accounts once with:  clasp login -u <account>

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$claspArgs
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$marker = Join-Path $scriptDir ".clasp-account"
$account = "default"

if (Test-Path $marker) {
    $account = (Get-Content $marker -Raw).Trim()
}

if (-not $account) {
    Write-Error "No account configured. Create $marker containing the clasp user name (e.g. drsanjiiiv), then run: clasp login -u $account"
    exit 1
}

$clasprc = Join-Path $env:USERPROFILE ".clasprc.json"
$registered = @()
if (Test-Path $clasprc) {
    $tokens = (Get-Content $clasprc -Raw | ConvertFrom-Json).tokens
    if ($tokens) { $registered = @($tokens.PSObject.Properties.Name) }
}

if ($registered -notcontains $account) {
    Write-Error "Account '$account' is not registered with clasp. Run: clasp login -u $account"
    exit 1
}

& clasp -u $account -P $scriptDir @claspArgs
exit $LASTEXITCODE
