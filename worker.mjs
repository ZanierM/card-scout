const origin = 'https://zanierm.github.io';
const ebay = 'https://api.ebay.com';
let token;
let pending;

async function mint(env) {
  const response = await fetch(ebay + '/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.EBAY_APP_ID + ':' + env.EBAY_CERT_ID),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: ebay + '/oauth/api_scope',
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('OAuth HTTP ' + response.status);
  const data = await response.json();
  if (!data.access_token) throw new Error('Missing OAuth token');
  token = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

async function applicationToken(env) {
  if (token?.expires > Date.now()) return token.value;
  pending ??= mint(env).finally(() => { pending = undefined; });
  return pending;
}

function listing(item, auction) {
  const price = auction ? item.currentBidPrice ?? item.price : item.price;
  if (!price || !Number.isFinite(Number(price.value)) || !item.itemWebUrl) return null;
  const url = new URL(item.itemWebUrl);
  if (url.protocol !== 'https:' || !/(^|\.)ebay\.(com|ca)$/.test(url.hostname)) return null;
  const shipping = (item.shippingOptions ?? [])
    .map(option => option.shippingCost)
    .filter(cost => cost?.currency === price.currency && Number.isFinite(Number(cost.value)))
    .map(cost => Number(cost.value));
  return {
    title: item.title,
    seller: item.seller?.username,
    url: url.href,
    currency: price.currency,
    price: Number(price.value),
    shipping: shipping.length ? Math.min(...shipping) : null,
  };
}

export default {
  async fetch(request, env) {
    const headers = { 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' };
    const reply = (data, status = 200) => Response.json(data, { status, headers });
    const url = new URL(request.url);
    if (url.pathname !== '/search' || request.method !== 'GET') return reply({ error: 'Not found.' }, 404);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const market = url.searchParams.get('market');
    const mode = url.searchParams.get('mode');
    const postal = (url.searchParams.get('postal') ?? '').toUpperCase().replace(/\s/g, '');
    const postalPattern = market === 'CA' ? /^[A-Z]\d[A-Z]\d[A-Z]\d$/ : /^\d{5}(-\d{4})?$/;
    if (!/\btopps\b/i.test(q) || q.length > 160 || !['US','CA'].includes(market) ||
        !['fixed','auction'].includes(mode) || (postal && !postalPattern.test(postal))) {
      return reply({ error: 'Enter a Topps search and a valid delivery location.' }, 400);
    }
    if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID || !env.SEARCH_LIMIT) {
      return reply({ error: 'Live search is awaiting backend configuration.' }, 503);
    }
    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const [client, overall] = await Promise.all([
        env.SEARCH_LIMIT.limit({ key: 'client:' + ip }),
        env.SEARCH_LIMIT.limit({ key: 'overall' }),
      ]);
      if (!client.success || !overall.success) return reply({ error: 'Too many searches. Try again shortly.' }, 429);
      const endpoint = new URL(ebay + '/buy/browse/v1/item_summary/search');
      const auction = mode === 'auction';
      endpoint.search = new URLSearchParams({
        q, limit: '40',
        filter: 'deliveryCountry:' + market + ',buyingOptions:{' + (auction ? 'AUCTION' : 'FIXED_PRICE') + '}',
      });
      const apiHeaders = {
        Authorization: 'Bearer ' + await applicationToken(env),
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_' + market,
      };
      if (postal) apiHeaders['X-EBAY-C-ENDUSERCTX'] = 'contextualLocation=' + encodeURIComponent('country=' + market + ',zip=' + postal);
      const response = await fetch(endpoint, { headers: apiHeaders, redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (!response.ok) {
        if (response.status === 401) token = undefined;
        return reply({ error: 'eBay search returned HTTP ' + response.status + '.' }, response.status === 429 ? 429 : 502);
      }
      const data = await response.json();
      return reply({ checked: new Date().toISOString(), items: (data.itemSummaries ?? []).map(item => listing(item, auction)).filter(Boolean) });
    } catch {
      return reply({ error: 'Live search is temporarily unavailable.' }, 502);
    }
  },
};
