const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000; // ИЗМЕНЕНО ДЛЯ RENDER

// Ваш прокси
const PROXY_URL = process.env.PROXY_URL || 'http://79984d06b862feef:mLKQJRuC@res.geonix.com:10000';

// Создаем агентов для HTTP и HTTPS
const httpsAgent = new HttpsProxyAgent(PROXY_URL);
const httpAgent = new HttpProxyAgent(PROXY_URL);

// Middleware для парсинга тела запроса
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// Функция для получения правильного агента
function getAgent(targetUrl) {
  return targetUrl.startsWith('https://') ? httpsAgent : httpAgent;
}

// Функция для переписывания ссылок в HTML
function rewriteHtml(html, baseUrl, proxyBase, usePath = false) {
  const $ = cheerio.load(html, { decodeEntities: false });
  
  // Функция для создания прокси URL
  function makeProxyUrl(targetUrl) {
    if (usePath) {
      return proxyBase + '/' + targetUrl;
    } else {
      return proxyBase + '/proxy?url=' + encodeURIComponent(targetUrl);
    }
  }
  
  // Переписываем различные типы ссылок
  const attributes = [
    { tag: 'a', attr: 'href' },
    { tag: 'link', attr: 'href' },
    { tag: 'script', attr: 'src' },
    { tag: 'img', attr: 'src' },
    { tag: 'img', attr: 'srcset' },
    { tag: 'source', attr: 'src' },
    { tag: 'source', attr: 'srcset' },
    { tag: 'iframe', attr: 'src' },
    { tag: 'form', attr: 'action' },
    { tag: 'video', attr: 'src' },
    { tag: 'audio', attr: 'src' }
  ];

  attributes.forEach(({ tag, attr }) => {
    $(tag).each((i, elem) => {
      const value = $(elem).attr(attr);
      if (value) {
        if (attr === 'srcset') {
          const rewritten = value.split(',').map(part => {
            const [urlPart, ...rest] = part.trim().split(/\s+/);
            const absoluteUrl = url.resolve(baseUrl, urlPart);
            return `${makeProxyUrl(absoluteUrl)} ${rest.join(' ')}`.trim();
          }).join(', ');
          $(elem).attr(attr, rewritten);
        } else {
          const absoluteUrl = url.resolve(baseUrl, value);
          if (!absoluteUrl.startsWith('javascript:') && 
              !absoluteUrl.startsWith('#') && 
              !absoluteUrl.startsWith('data:') &&
              !absoluteUrl.startsWith('mailto:') &&
              !absoluteUrl.startsWith('tel:')) {
            $(elem).attr(attr, makeProxyUrl(absoluteUrl));
          }
        }
      }
    });
  });

  // Переписываем формы
  $('form').each((i, elem) => {
    const formId = `proxy-form-${i}`;
    $(elem).attr('id', formId);
    $(elem).attr('onsubmit', `return proxyFormSubmit(event, '${formId}')`);
  });

  // Добавляем base tag
  if (!$('base').length) {
    $('head').prepend(`<base href="${makeProxyUrl(baseUrl)}">`);
  }
  
  // Добавляем мета-тег с информацией об оригинальном домене
  $('head').prepend(`<meta name="original-domain" content="${new URL(baseUrl).origin}">`);
  $('head').prepend(`<meta name="proxy-mode" content="true">`);

  // Внедряем расширенный скрипт для перехвата всех запросов
  const interceptScript = `
    <script>
      (function() {
        const proxyBase = '${proxyBase}';
        const currentTargetUrl = '${baseUrl}';
        const originalDomain = '${new URL(baseUrl).origin}';
        const usePath = ${usePath};
        const originalFetch = window.fetch;
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        
        // Список доменов SumSub которые нужно проксировать
        const sumsabDomains = [
          'in.sumsub.com',
          'api.sumsub.com', 
          'in.sum-sdk.com',
          'api.sum-sdk.com'
        ];
        
        function shouldProxy(url) {
          return sumsabDomains.some(domain => url.includes(domain));
        }
        
        function proxyUrl(targetUrl) {
          if (!targetUrl) return targetUrl;
          
          if (targetUrl.startsWith('data:') || 
              targetUrl.startsWith('blob:') || 
              targetUrl.startsWith('javascript:') ||
              targetUrl.startsWith('#')) {
            return targetUrl;
          }
          
          let absoluteUrl = targetUrl;
          if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            try {
              absoluteUrl = new URL(targetUrl, currentTargetUrl).href;
            } catch (e) {
              return targetUrl;
            }
          }
          
          // Если URL уже проксированный или это localhost
          if (absoluteUrl.includes('localhost:3000') || absoluteUrl.includes(proxyBase)) {
            return absoluteUrl;
          }
          
          // Проксируем только домены SumSub
          if (shouldProxy(absoluteUrl)) {
            // Заменяем домены на наш прокси
            let proxiedUrl = absoluteUrl;
            sumsabDomains.forEach(domain => {
              proxiedUrl = proxiedUrl.replace('https://' + domain, proxyBase);
              proxiedUrl = proxiedUrl.replace('http://' + domain, proxyBase);
            });
            console.log('🔄 Proxying:', targetUrl, '→', proxiedUrl);
            return proxiedUrl;
          }
          
          return absoluteUrl;
        }
        
        // Перехватываем fetch
        window.fetch = function(resource, init) {
          let targetUrl = typeof resource === 'string' ? resource : resource.url;
          const proxiedUrl = proxyUrl(targetUrl);
          
          // КРИТИЧНО: Добавляем заголовки чтобы SDK работал
          init = init || {};
          init.headers = init.headers || {};
          
          // Не трогаем Origin - браузер сам установит правильный
          // Но добавим custom header с оригинальным доменом
          if (init.headers instanceof Headers) {
            init.headers.append('X-Original-Origin', originalDomain);
          } else {
            init.headers['X-Original-Origin'] = originalDomain;
          }
          
          if (typeof resource === 'string') {
            return originalFetch.call(this, proxiedUrl, init);
          } else {
            const newRequest = new Request(proxiedUrl, resource);
            return originalFetch.call(this, newRequest, init);
          }
        };
        
        // Перехватываем XMLHttpRequest
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this._proxyUrl = proxyUrl(url);
          this._originalUrl = url;
          return originalOpen.call(this, method, this._proxyUrl, ...rest);
        };
        
        // Перехватываем send чтобы добавить кастомный заголовок
        XMLHttpRequest.prototype.send = function(data) {
          if (this._originalUrl && shouldProxy(this._originalUrl)) {
            this.setRequestHeader('X-Original-Origin', originalDomain);
          }
          return originalSend.call(this, data);
        };
        
        // Перехватываем формы
        window.proxyFormSubmit = function(event, formId) {
          event.preventDefault();
          const form = document.getElementById(formId);
          const formData = new FormData(form);
          const params = new URLSearchParams(formData);
          
          let action = form.action || window.location.href;
          if (!action.startsWith('http')) {
            action = new URL(action, currentTargetUrl).href;
          }
          
          const targetUrl = action + (action.includes('?') ? '&' : '?') + params.toString();
          if (usePath) {
            window.location.href = proxyBase + '/' + targetUrl;
          } else {
            window.location.href = proxyBase + '/proxy?url=' + encodeURIComponent(targetUrl);
          }
          return false;
        };
        
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName) {
          const element = originalCreateElement.call(document, tagName);
          
          if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'img') {
            const originalSetAttribute = element.setAttribute;
            element.setAttribute = function(name, value) {
              if (name === 'src') {
                value = proxyUrl(value);
              }
              return originalSetAttribute.call(this, name, value);
            };
          }
          
          return element;
        };
        
        ['HTMLImageElement', 'HTMLScriptElement', 'HTMLIFrameElement'].forEach(className => {
          if (window[className]) {
            const descriptor = Object.getOwnPropertyDescriptor(window[className].prototype, 'src');
            if (descriptor && descriptor.set) {
              const originalSet = descriptor.set;
              Object.defineProperty(window[className].prototype, 'src', {
                set: function(value) {
                  return originalSet.call(this, proxyUrl(value));
                },
                get: descriptor.get
              });
            }
          }
        });
        
        console.log('🔄 Proxy interceptor loaded for:', currentTargetUrl);
        console.log('🔄 Proxying domains:', sumsabDomains);
      })();
    </script>
  `;
  
  $('head').prepend(interceptScript);

  return $.html();
}

// Middleware для логирования
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log(`User-Agent: ${req.headers['user-agent'] || 'none'}`);
  console.log(`Accept: ${req.headers['accept'] || 'none'}`);
  if (req.headers['content-type']) {
    console.log(`Content-Type: ${req.headers['content-type']}`);
  }
  next();
});

// Функция для проксирования запроса
async function proxyRequest(req, res, targetUrl, usePath = false) {
  try {
    console.log(`📡 ${req.method} ${targetUrl}`);
    if (targetUrl.includes('?')) {
      const params = new URL(targetUrl).searchParams;
      console.log(`   Query params:`, Object.fromEntries(params));
    }
    if (req.headers['cookie']) {
      console.log(`   Cookies:`, req.headers['cookie'].substring(0, 100) + '...');
    }

    let data = req.body;
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/x-www-form-urlencoded') && typeof data === 'object') {
      data = new URLSearchParams(data).toString();
    }

    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.method !== 'GET' && req.method !== 'HEAD' ? data : undefined,
      httpAgent: getAgent(targetUrl),
      httpsAgent: getAgent(targetUrl),
      headers: {
        'Host': new URL(targetUrl).host,
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': targetUrl,
        'Origin': new URL(targetUrl).origin,
        'DNT': '1',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...(req.headers['x-client-id'] && { 'X-Client-Id': req.headers['x-client-id'] }),
        ...(req.headers['authorization'] && { 'Authorization': req.headers['authorization'] }),
        ...(req.headers['x-app-token'] && { 'X-App-Token': req.headers['x-app-token'] }),
        ...(req.headers['x-app-access-token'] && { 'X-App-Access-Token': req.headers['x-app-access-token'] }),
        ...(req.headers['x-app-access-sig'] && { 'X-App-Access-Sig': req.headers['x-app-access-sig'] }),
        ...(req.headers['x-app-access-ts'] && { 'X-App-Access-Ts': req.headers['x-app-access-ts'] }),
        ...(req.headers['content-type'] && { 'Content-Type': req.headers['content-type'] })
      },
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    console.log(`   ✅ Response: ${response.status} ${response.statusText}`);
    
    if (response.headers['set-cookie']) {
      console.log(`   🍪 Set-Cookie received`);
    }
    
    if (response.status === 403 || response.status === 404 || response.status === 401) {
      console.log(`   ⚠️ Auth issue! Status: ${response.status}`);
      console.log(`   Request URL: ${targetUrl}`);
    }

    const responseContentType = response.headers['content-type'] || '';
    
    Object.keys(response.headers).forEach(key => {
      const lowerKey = key.toLowerCase();
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection', 
            'content-security-policy', 'x-frame-options', 'x-content-type-options'].includes(lowerKey)) {
        if (lowerKey === 'set-cookie') {
          const cookies = Array.isArray(response.headers[key]) ? response.headers[key] : [response.headers[key]];
          cookies.forEach(cookie => {
            let modifiedCookie = cookie
              .replace(/Domain=\.?[^;]+/gi, 'Domain=localhost')
              .replace(/Path=\/[^;]*/gi, 'Path=/')
              .replace(/Secure[;]?/gi, '');
            res.append('Set-Cookie', modifiedCookie);
          });
        } else {
          res.setHeader(key, response.headers[key]);
        }
      }
    });

    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.status(response.status);

    if (responseContentType.includes('javascript') || responseContentType.includes('application/json') || targetUrl.includes('.js')) {
      let content = response.data.toString('utf-8');
      
      const domains = [
        'https://in.sumsub.com',
        'https://api.sumsub.com',
        'https://in.sum-sdk.com',
        'https://api.sum-sdk.com',
        'in.sumsub.com',
        'api.sumsub.com',
        'in.sum-sdk.com',
        'api.sum-sdk.com'
      ];
      
      // ВАЖНОЕ ИЗМЕНЕНИЕ: Используем req.get('host') вместо localhost
      const proxyHost = req.get('host');
      const proxyProtocol = req.protocol;
      const proxyUrl = `${proxyProtocol}://${proxyHost}`;
      
      domains.forEach(domain => {
        const regex1 = new RegExp(domain.replace(/\./g, '\\.'), 'g');
        content = content.replace(regex1, proxyUrl);
        
        const domainOnly = domain.replace('https://', '').replace('http://', '');
        const regex2 = new RegExp(`"${domainOnly}"`, 'g');
        content = content.replace(regex2, `"${proxyHost}"`);
        
        const regex3 = new RegExp(`'${domainOnly}'`, 'g');
        content = content.replace(regex3, `'${proxyHost}'`);
      });
      
      console.log(`   🔄 JavaScript/JSON rewritten`);
      res.send(content);
    } else if (responseContentType.includes('text/html')) {
      const html = response.data.toString('utf-8');
      const proxyHost = req.get('host');
      const proxyProtocol = req.protocol;
      const proxyUrl = `${proxyProtocol}://${proxyHost}`;
      const rewrittenHtml = rewriteHtml(html, targetUrl, proxyUrl, usePath);
      res.send(rewrittenHtml);
    } else {
      res.send(response.data);
    }

  } catch (error) {
    console.error('❌ Ошибка прокси:', error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
    }
    
    if (req.headers['accept']?.includes('application/json') || targetUrl.includes('/api/') || targetUrl.includes('.json')) {
      res.status(error.response?.status || 500).json({ error: error.message });
    } else {
      res.status(500).send(`
        <html>
          <head><title>Ошибка</title></head>
          <body>
            <h1>Ошибка при проксировании</h1>
            <p>URL: ${targetUrl}</p>
            <p>Ошибка: ${error.message}</p>
            <p><a href="/">← Вернуться на главную</a></p>
          </body>
        </html>
      `);
    }
    
    throw error;
  }
}

// Обработчик query-based прокси (/proxy?url=...)
app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send(`
      <html>
        <head>
          <title>Реверс-прокси</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            input { width: 100%; padding: 10px; font-size: 16px; margin: 10px 0; box-sizing: border-box; }
            button { padding: 10px 20px; font-size: 16px; cursor: pointer; background: #007bff; color: white; border: none; }
            .example { margin: 20px 0; padding: 15px; background: #f5f5f5; }
          </style>
        </head>
        <body>
          <h1>Реверс-прокси сервер</h1>
          <p>Использование: <code>/proxy?url=https://example.com</code></p>
          <form method="GET" action="/proxy">
            <input type="text" name="url" placeholder="https://sumsub.com" required>
            <button type="submit">Открыть через прокси</button>
          </form>
          <div class="example">
            <h3>Примеры:</h3>
            <ul>
              <li><a href="/proxy?url=https://sumsub.com">/proxy?url=https://sumsub.com</a></li>
              <li><a href="/proxy?url=https://youtube.com">/proxy?url=https://youtube.com</a></li>
            </ul>
          </div>
        </body>
      </html>
    `);
  }

  await proxyRequest(req, res, targetUrl, false);
});

// Обработчик OPTIONS для CORS
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.status(200).send();
});

// Обработчик path-based прокси (/https://example.com)
app.all(/^\/(https?:\/\/.+)/, async (req, res) => {
  const targetUrl = req.params[0];
  
  if (req.url.includes('?')) {
    const queryString = req.url.split('?')[1];
    const fullUrl = targetUrl + '?' + queryString;
    await proxyRequest(req, res, fullUrl, true);
  } else {
    await proxyRequest(req, res, targetUrl, true);
  }
});

// Обработчик для всех API запросов SumSub (любые домены)
app.all(/^\/(websdk|idensic|api|i18n|resources)\/(.*)/, async (req, res) => {
  const prefix = req.params[0];
  const path = req.params[1];
  
  const urlParts = req.originalUrl.split('?');
  const queryString = urlParts.length > 1 ? '?' + urlParts.slice(1).join('?') : '';
  
  const domains = ['in.sumsub.com', 'api.sumsub.com', 'in.sum-sdk.com'];
  
  for (const domain of domains) {
    const targetUrl = `https://${domain}/${prefix}/${path}${queryString}`;
    console.log(`🔄 Trying SumSub ${req.method}: ${targetUrl}`);
    
    try {
      await proxyRequest(req, res, targetUrl, true);
      return;
    } catch (error) {
      console.log(`   ❌ Failed with ${domain}, trying next...`);
      continue;
    }
  }
  
  console.log(`   ⚠️ All domains failed for /${prefix}/${path}`);
  res.status(404).send('Resource not found on any SumSub domain');
});

// Обработчик для аналитики stry
app.all(/^\/stry(.*)/, async (req, res) => {
  const path = req.params[0] || '';
  const queryString = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  
  const domains = ['api.sumsub.com', 'in.sumsub.com', 'stry.sumsub.com'];
  
  for (const domain of domains) {
    const targetUrl = `https://${domain}/stry${path}${queryString}`;
    console.log(`📊 Trying stry: ${targetUrl}`);
    
    try {
      await proxyRequest(req, res, targetUrl, true);
      return;
    } catch (error) {
      console.log(`   ❌ Failed with ${domain}`);
      continue;
    }
  }
  
  console.log(`   ⚠️ Stry failed on all domains, returning empty response`);
  res.status(204).send();
});

// Обработчик для статических ресурсов SumSub
app.all(/^\/(static|assets|chunk|bundles)\/(.+)/, async (req, res) => {
  const prefix = req.params[0];
  const path = req.params[1];
  const targetUrl = `https://in.sumsub.com/${prefix}/${path}`;
  
  console.log(`📦 SumSub static: ${targetUrl}`);
  await proxyRequest(req, res, targetUrl, true);
});

// Обработчик для корневых файлов
app.all(/^\/(favicon\.ico|robots\.txt|manifest\.json)/, async (req, res) => {
  const file = req.params[0];
  const targetUrl = `https://in.sumsub.com/${file}`;
  
  console.log(`📄 SumSub file: ${targetUrl}`);
  await proxyRequest(req, res, targetUrl, true);
});

// Главная страница
app.get('/', (req, res) => {
  const proxyHost = req.get('host');
  const proxyProtocol = req.protocol;
  const proxyUrl = `${proxyProtocol}://${proxyHost}`;
  
  res.send(`
    <html>
      <head>
        <title>Реверс-прокси сервер</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; }
          input { width: 100%; padding: 10px; font-size: 16px; box-sizing: border-box; }
          button { padding: 10px 20px; font-size: 16px; margin-top: 10px; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px; }
          button:hover { background: #0056b3; }
          .example { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 5px; }
          h1 { color: #333; }
          code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
          .method { color: #28a745; font-weight: bold; }
          .url-example { background: #fff; padding: 8px; border-left: 3px solid #007bff; margin: 5px 0; }
        </style>
      </head>
      <body>
        <h1>🔄 Реверс-прокси сервер</h1>
        <p>Введите URL сайта для проксирования:</p>
        <form action="/proxy" method="GET">
          <input type="text" name="url" placeholder="https://in.sumsub.com/websdk/p/..." required>
          <button type="submit">Открыть через прокси</button>
        </form>
        
        <div class="example">
          <h3>📋 Использование для SumSub:</h3>
          
          <p class="method">Замените домен в вашей ссылке:</p>
          <div class="url-example">
            <strong>Было:</strong><br>
            <code>https://in.sumsub.com/websdk/p/YOUR_TOKEN?from=linkMobile</code>
          </div>
          <div class="url-example">
            <strong>Стало:</strong><br>
            <code>${proxyUrl}/websdk/p/YOUR_TOKEN?from=linkMobile</code>
          </div>
        </div>
        
        <div class="example">
          <h3>✅ Статус:</h3>
          <p>✅ Сервер работает на ${proxyUrl}</p>
          <p>✅ Прокси: res.geonix.com:10000</p>
          <p>✅ Поддержка: GET, POST, формы, AJAX, fetch</p>
          <p>✅ CORS включен для SDK</p>
        </div>
      </body>
    </html>
  `);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🔄 Реверс-прокси сервер запущен [v3]                     ║
╚═══════════════════════════════════════════════════════════╝

🔡 Сервер:    http://localhost:${PORT}
🌐 Прокси:    res.geonix.com:10000

🎯 Используйте свежую ссылку от SumSub
✅ HTTPS ready для Render.com
✅ Динамический домен поддержка

Нажмите Ctrl+C для остановки
  `);
});