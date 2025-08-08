require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

const allowedOrigins = [
  'https://app.bikesultoursgest.com',
  'https://api.bikesultoursgest.com'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.log(`❌ CORS blocked for origin: ${origin}`);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type','Authorization','User-Agent','Cache-Control','Pragma',
    'Accept','Accept-Encoding','Accept-Language','X-Requested-With',
    'Origin','Referer','If-None-Match','If-Modified-Since'
  ],
  exposedHeaders: ['Cache-Control','ETag','Last-Modified','X-Cache-Status','CF-Cache-Tag'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.options('*', cors());

app.use((req, res, next) => {
  const origin = req.get('Origin');
  const method = req.method;
  if (method === 'OPTIONS' || origin) {
    console.log(`🌐 ${method} ${req.path} from ${origin || 'no-origin'}`);
  }
  next();
});

app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 4000;
const ALUGUERES_CATEGORY_ID = parseInt(process.env.ALUGUERES_CATEGORY_ID || '319', 10);

function parseJSONSafe(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

function extractACFPricing(acfData, metaData = []) {
  const pricing = {};
  
  // Primero intentar desde ACF data
  if (acfData && typeof acfData === 'object') {
    if (acfData.precio_1_2 !== undefined && acfData.precio_1_2 !== null && acfData.precio_1_2 !== '') {
      pricing.precio_1_2 = Number(acfData.precio_1_2);
    }
    if (acfData.precio_3_6 !== undefined && acfData.precio_3_6 !== null && acfData.precio_3_6 !== '') {
      pricing.precio_3_6 = Number(acfData.precio_3_6);
    }
    if (acfData.precio_7_mais !== undefined && acfData.precio_7_mais !== null && acfData.precio_7_mais !== '') {
      pricing.precio_7_mais = Number(acfData.precio_7_mais);
    }
  }
  
  // Si no encontramos nada en ACF, intentar en meta_data
  if (Object.keys(pricing).length === 0 && Array.isArray(metaData)) {
    metaData.forEach(meta => {
      if (!meta || typeof meta !== 'object') return;
      
      const key = meta.key || meta.name || '';
      const val = meta.value !== undefined ? meta.value : meta.val;
      
      if (val === undefined || val === null || val === '') return;
      
      // Verificar tanto con underscore como sin underscore
      if (key === 'precio_1_2' || key === '_precio_1_2') {
        const numVal = Number(val);
        if (!isNaN(numVal) && numVal > 0) pricing.precio_1_2 = numVal;
      }
      if (key === 'precio_3_6' || key === '_precio_3_6') {
        const numVal = Number(val);
        if (!isNaN(numVal) && numVal > 0) pricing.precio_3_6 = numVal;
      }
      if (key === 'precio_7_mais' || key === '_precio_7_mais') {
        const numVal = Number(val);
        if (!isNaN(numVal) && numVal > 0) pricing.precio_7_mais = numVal;
      }
    });
  }
  
  console.log(`🔍 ACF Pricing extraído:`, pricing);
  return pricing;
}

function processProductForResponse(dbProduct) {
  try {
    const categories = parseJSONSafe(dbProduct.categories, []);
    const images = parseJSONSafe(dbProduct.images, []);
    const acfData = parseJSONSafe(dbProduct.acf_data, {});
    const metaData = parseJSONSafe(dbProduct.meta_data, []);
    const variationsIds = parseJSONSafe(dbProduct.variations_ids, []);
    const variationsStock = parseJSONSafe(dbProduct.variations_stock, []);

    const subcategory = Array.isArray(categories) ? categories.find(cat => cat && cat.slug && cat.slug !== 'alugueres') : undefined;
    const primaryCategory = subcategory ? subcategory.slug : 'general';

    const mainImage = Array.isArray(images) && images.length > 0 ? (images[0].src || images[0].url || '/placeholder.svg') : '/placeholder.svg';

    const acfPricing = extractACFPricing(acfData, metaData);

    let calculatedPrice = 0;
    if (dbProduct.price !== undefined && dbProduct.price !== null && dbProduct.price !== '') calculatedPrice = parseFloat(dbProduct.price) || 0;
    else if (dbProduct.regular_price !== undefined && dbProduct.regular_price !== null && dbProduct.regular_price !== '') calculatedPrice = parseFloat(dbProduct.regular_price) || 0;

    if (acfPricing.precio_1_2) {
      const p = parseFloat(acfPricing.precio_1_2);
      if (!isNaN(p)) calculatedPrice = p;
    }

    return {
      id: dbProduct.woocommerce_id ? dbProduct.woocommerce_id.toString() : (dbProduct.id ? dbProduct.id.toString() : '0'),
      name: dbProduct.name || '',
      type: primaryCategory,
      price: calculatedPrice,
      regular_price: parseFloat(dbProduct.regular_price || 0),
      available: dbProduct.stock_quantity || 0,
      stock_quantity: dbProduct.stock_quantity || 0,
      stock_status: dbProduct.stock_status || 'instock',
      image: mainImage,
      images: images,
      description: dbProduct.short_description || dbProduct.description || '',
      short_description: dbProduct.short_description || '',
      categories: categories,
      status: dbProduct.status || 'publish',
      woocommerce_id: dbProduct.woocommerce_id,
      acf_data: acfData,
      acf_pricing: acfPricing,
      meta_data: metaData,
      variations_ids: variationsIds,
      variations_stock: variationsStock,
      sku: dbProduct.sku || '',
      category: primaryCategory
    };
  } catch (err) {
    console.error('Error procesando producto:', err);
    return {
      id: dbProduct.id?.toString() || 'unknown',
      name: dbProduct.name || 'Produto sem nome',
      type: 'general',
      price: parseFloat(dbProduct.price || 0),
      available: dbProduct.stock_quantity || 0,
      image: '/placeholder.svg',
      description: dbProduct.description || '',
      status: dbProduct.status || 'publish',
      woocommerce_id: dbProduct.woocommerce_id
    };
  }
}

async function fetchVariationsFromWoo(productId) {
  const base = process.env.WOOCOMMERCE_API_BASE;
  const auth = {
    username: process.env.WOOCOMMERCE_CONSUMER_KEY,
    password: process.env.WOOCOMMERCE_CONSUMER_SECRET
  };
  const per_page = 100;
  let page = 1;
  let all = [];

  try {
    while (true) {
      const resp = await axios.get(`${base}/products/${productId}/variations`, {
        params: { per_page, page },
        auth,
        timeout: 30000
      });
      if (!Array.isArray(resp.data) || resp.data.length === 0) break;
      all = all.concat(resp.data);
      if (resp.data.length < per_page) break;
      page++;
    }
  } catch (err) {
    console.error(`❌ Error fetching variations for product ${productId}:`, err.response?.data || err.message || err);
  }
  return all;
}

// ===== RUTA HEALTH =====
app.get('/health', (req, res) => {
  console.log('💓 Health check solicitado');

  // Headers CORS explícitos para health check
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Health-Check': 'true'
  });

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    message: 'Backend Render está operacional'
  });
});

// ===== RUTA STATUS (ALIAS DE HEALTH) =====
app.get('/status', (req, res) => {
  console.log('📊 Status check solicitado');

  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Status-Check': 'true'
  });

  res.json({
    status: 'ok',
    health: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    message: 'Backend Render está operacional'
  });
});

// ===== RUTA GET PRODUCTS =====
app.get('/products', async (req, res) => {
  console.log('📦 Solicitando productos desde la base de datos...');

  try {
    const category = req.query.category;
    let query;
    let queryParams = [];

    // Headers para cache en Cloudflare
    res.set({
      'Cache-Control': 'public, max-age=300, s-maxage=600', // 5min browser, 10min CDN
      'ETag': `products-${Date.now()}`,
      'X-Cache-Strategy': 'cloudflare-cache',
      'CF-Cache-Tag': 'products,alugueres,bikesul'
    });

    if (category) {
      // Filtrar por categoría específica
      query = `
        SELECT * FROM products
        WHERE categories::text ILIKE $1
        AND status = 'publish'
        ORDER BY name ASC
      `;
      queryParams = [`%"slug":"${category}"%`];
      console.log(`🔍 Filtrando por categoría: ${category}`);
    } else {
      // Obtener todos los productos de la categoría "alugueres"
      query = `
        SELECT * FROM products
        WHERE categories::jsonb @> '[{"id": ${ALUGUERES_CATEGORY_ID}}]'
        AND status = 'publish'
        ORDER BY name ASC
      `;
      console.log(`📋 Obteniendo todos los productos de ALUGUERES (${ALUGUERES_CATEGORY_ID})`);
    }

    const { rows } = await db.query(query, queryParams);
    console.log(`✅ ${rows.length} productos encontrados en la base de datos`);

    const responseProducts = rows.map(processProductForResponse);

    res.json(responseProducts);
  } catch (error) {
    console.error('❌ Error obteniendo productos:', error);
    res.status(500).json({
      error: 'Error interno del servidor',
      message: error.message
    });
  }
});

// ===== RUTA GET PRODUCT BY ID =====
app.get('/products/:id', async (req, res) => {
  console.log(`🔍 Solicitando producto con ID: ${req.params.id}`);

  try {
    const productId = req.params.id;

    // Headers para cache individualizado
    res.set({
      'Cache-Control': 'public, max-age=600, s-maxage=1200', // 10min browser, 20min CDN
      'ETag': `product-${productId}-${Date.now()}`,
      'CF-Cache-Tag': `product-${productId},products,alugueres`
    });

    const { rows } = await db.query(
      'SELECT * FROM products WHERE woocommerce_id = $1 OR id = $1',
      [productId]
    );

    if (rows.length === 0) {
      console.log(`❌ Producto ${productId} no encontrado`);
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    const responseProduct = processProductForResponse(rows[0]);
    console.log(`✅ Producto ${productId} encontrado: ${responseProduct.name}`);

    res.json(responseProduct);
  } catch (error) {
    console.error(`❌ Error obteniendo producto ${req.params.id}:`, error);
    res.status(500).json({
      error: 'Error interno del servidor',
      message: error.message
    });
  }
});

app.get('/sync-products', async (req, res) => {
  console.log('🔄 Iniciando sincronización de productos (incluye variaciones)...');

  const base = process.env.WOOCOMMERCE_API_BASE;
  const auth = {
    username: process.env.WOOCOMMERCE_CONSUMER_KEY,
    password: process.env.WOOCOMMERCE_CONSUMER_SECRET
  };
  const per_page = 100;
  let page = 1;
  let totalSynced = 0;
  let totalErrors = 0;
  let totalFetched = 0;

  try {
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_products_categories_gin ON products USING gin (categories jsonb_path_ops)`);
      console.log('✅ Índice GIN en categories asegurado.');
    } catch (indexErr) {
      console.warn('⚠️ No se pudo crear índice GIN (posible privilegios).', indexErr.message || indexErr);
    }

    while (true) {
      const resp = await axios.get(`${base}/products`, {
        params: { category: ALUGUERES_CATEGORY_ID, status: 'publish', per_page, page },
        auth,
        timeout: 30000
      });

      const products = Array.isArray(resp.data) ? resp.data : [];
      if (products.length === 0) break;
      totalFetched += products.length;

      for (const product of products) {
        try {
          const belongs = Array.isArray(product.categories) && product.categories.some(c => Number(c.id) === ALUGUERES_CATEGORY_ID);
          if (!belongs) {
            console.log(`⏭️ Producto ${product.id} no pertenece a ALUGUERES, saltando.`);
            continue;
          }

          console.log(`📝 Procesando producto ${product.id}: ${product.name}`);
          console.log(`🔍 ACF Data recibido:`, JSON.stringify(product.acf, null, 2));
          console.log(`🔍 Meta Data recibido:`, JSON.stringify(product.meta_data, null, 2));

          let variationsStock = [];
          let variationsIds = [];

          if (product.type === 'variable' || (Array.isArray(product.variations) && product.variations.length > 0)) {
            const variations = await fetchVariationsFromWoo(product.id);
            variationsIds = variations.map(v => v.id);
            variationsStock = variations.map(v => ({
              id: v.id,
              sku: v.sku || null,
              stock_quantity: v.stock_quantity !== undefined && v.stock_quantity !== null ? Number(v.stock_quantity) : null,
              stock_status: v.stock_status || null,
              price: v.price !== undefined ? v.price : null,
              regular_price: v.regular_price !== undefined ? v.regular_price : null,
              attributes: v.attributes || []
            }));
          } else {
            variationsIds = product.variations || [];
            variationsStock = [];
          }

          let aggregatedStock = 0;
          if (variationsStock.length > 0) {
            aggregatedStock = variationsStock.reduce((acc, vs) => {
              const q = Number.isFinite(Number(vs.stock_quantity)) ? Number(vs.stock_quantity) : 0;
              return acc + q;
            }, 0);
          } else {
            aggregatedStock = product.stock_quantity !== undefined && product.stock_quantity !== null ? Number(product.stock_quantity) : 0;
          }

          const acfData = product.acf || {};
          const metaData = product.meta_data || [];

          const acfPricing = extractACFPricing(acfData, metaData);
          console.log(`💰 ACF Pricing extraído para ${product.id}:`, acfPricing);

          const priceToUse = acfPricing.precio_1_2 !== undefined ? Number(acfPricing.precio_1_2)
                            : (product.price !== undefined ? Number(product.price) : 0);

          const queryText = `
            INSERT INTO products (
              woocommerce_id, name, price, regular_price, stock_quantity,
              stock_status, categories, images, description, short_description,
              status, acf_data, meta_data, variations_ids, variations_stock,
              sku, precio_1_2, precio_3_6, precio_7_mais
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
            )
            ON CONFLICT (woocommerce_id) DO UPDATE SET
              name = EXCLUDED.name,
              price = EXCLUDED.price,
              regular_price = EXCLUDED.regular_price,
              stock_quantity = EXCLUDED.stock_quantity,
              stock_status = EXCLUDED.stock_status,
              categories = EXCLUDED.categories,
              images = EXCLUDED.images,
              description = EXCLUDED.description,
              short_description = EXCLUDED.short_description,
              status = EXCLUDED.status,
              acf_data = EXCLUDED.acf_data,
              meta_data = EXCLUDED.meta_data,
              variations_ids = EXCLUDED.variations_ids,
              variations_stock = EXCLUDED.variations_stock,
              sku = EXCLUDED.sku,
              precio_1_2 = EXCLUDED.precio_1_2,
              precio_3_6 = EXCLUDED.precio_3_6,
              precio_7_mais = EXCLUDED.precio_7_mais
          `;

          const values = [
            product.id,
            product.name || '',
            priceToUse,
            product.regular_price !== undefined ? Number(product.regular_price) : 0,
            aggregatedStock,
            product.stock_status || 'instock',
            JSON.stringify(product.categories || []),
            JSON.stringify(product.images || []),
            product.description || '',
            product.short_description || '',
            product.status || 'publish',
            JSON.stringify(acfData),
            JSON.stringify(metaData),
            JSON.stringify(variationsIds),
            JSON.stringify(variationsStock),
            product.sku || '',
            acfPricing.precio_1_2 || null,
            acfPricing.precio_3_6 || null,
            acfPricing.precio_7_mais || null
          ];

          console.log(`💾 Guardando en BD - precios ACF: 1-2: ${values[16]}, 3-6: ${values[17]}, 7+: ${values[18]}`);

          await db.query(queryText, values);
          totalSynced++;
          console.log(`✅ Producto sincronizado: ${product.id} - ${product.name}`);

        } catch (prodErr) {
          totalErrors++;
          console.error(`❌ Error sincronizando producto ${product.id}:`, prodErr.message || prodErr);
        }
      }

      if (products.length < per_page) break;
      page++;
    }

    // Obtener los productos de la categoría "alugueres" desde DB para responder
    const { rows } = await db.query(`SELECT * FROM products WHERE categories::jsonb @> '[{"id": ${ALUGUERES_CATEGORY_ID}}]'`);
    const responseProducts = rows.map(processProductForResponse);

    res.json({
      message: `Sincronización completada: ${totalSynced} productos sincronizados, ${totalErrors} errores, ${totalFetched} productos recuperados.`,
      products: responseProducts
    });

  } catch (err) {
    console.error('❌ Error en sincronización general:', err.message || err);
    res.status(500).json({ error: 'Error interno en la sincronización' });
  }
});

// ===== ENDPOINT SYNC-STATUS =====
app.get('/sync-status', async (req, res) => {
  console.log('📊 Verificando status da sincronização...');

  try {
    // Headers para no-cache (siempre datos frescos)
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Sync-Status-Check': 'true'
    });

    // Contar productos en BD
    const totalCount = await db.query('SELECT COUNT(*) as total FROM products');
    const alugueresCount = await db.query(
      `SELECT COUNT(*) as alugueres_total FROM products
       WHERE categories::jsonb @> '[{"id": ${ALUGUERES_CATEGORY_ID}}]'`
    );

    const syncStatus = {
      last_check: new Date().toISOString(),
      total_products_in_db: parseInt(totalCount.rows[0].total),
      alugueres_products: parseInt(alugueresCount.rows[0].alugueres_total),
      category_filter: ALUGUERES_CATEGORY_ID,
      sync_healthy: parseInt(alugueresCount.rows[0].alugueres_total) > 0
    };

    console.log('✅ Sync status:', syncStatus);
    res.json(syncStatus);
  } catch (error) {
    console.error('❌ Error verificando sync status:', error);
    res.status(500).json({
      error: 'Error verificando status de sincronização',
      message: error.message
    });
  }
});

// ===== ENDPOINT CORS-TEST =====
app.get('/cors-test', (req, res) => {
  console.log('🧪 CORS Test request received');
  console.log('Origin:', req.get('Origin'));
  console.log('User-Agent:', req.get('User-Agent'));

  // Headers explícitos para teste CORS
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Cache-Control': 'no-cache',
    'X-CORS-Test': 'success'
  });

  res.json({
    message: 'CORS test successful',
    origin: req.get('Origin') || 'No origin header',
    method: req.method,
    timestamp: new Date().toISOString(),
    headers_received: req.headers
  });
});

// ===== ENDPOINT DEBUG-PRODUCTS =====
app.get('/debug-products', async (req, res) => {
  console.log('🐛 Debug de productos solicitado...');

  try {
    // Headers para no-cache
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Debug-Endpoint': 'true'
    });

    // Contar total de productos
    const totalCount = await db.query('SELECT COUNT(*) as total FROM products');

    // Contar productos ALUGUERES
    const alugueresCount = await db.query(
      `SELECT COUNT(*) as alugueres_total FROM products
       WHERE categories::jsonb @> '[{"id": ${ALUGUERES_CATEGORY_ID}}]'`
    );

    // Contar productos ALUGUERES por status
    const statusBreakdown = await db.query(
      `SELECT
         status,
         stock_status,
         COUNT(*) as count,
         AVG(stock_quantity) as avg_stock
       FROM products
       WHERE categories::jsonb @> '[{"id": ${ALUGUERES_CATEGORY_ID}}]'
       GROUP BY status, stock_status
       ORDER BY count DESC`
    );

    // Ejemplo de productos ALUGUERES (primeros 5)
    const sampleProducts = await db.query(
      `SELECT
         woocommerce_id, name, status, stock_status, stock_quantity,
         categories::text as categories_preview
       FROM products
       WHERE categories::jsonb @> '[{"id": ${ALUGUERES_CATEGORY_ID}}]'
       LIMIT 5`
    );

    const debugInfo = {
      total_products_in_db: parseInt(totalCount.rows[0].total),
      alugueres_products_total: parseInt(alugueresCount.rows[0].alugueres_total),
      status_breakdown: statusBreakdown.rows,
      sample_products: sampleProducts.rows,
      category_filter: `ID: ${ALUGUERES_CATEGORY_ID}`,
      timestamp: new Date().toISOString()
    };

    console.log('🐛 Debug info:', JSON.stringify(debugInfo, null, 2));
    res.json(debugInfo);
  } catch (error) {
    console.error('❌ Error no debug:', error.message);
    res.status(500).json({
      error: 'Error no debug de produtos',
      details: error.message
    });
  }
});

// ===== ENDPOINT CLEAR-CACHE =====
app.post('/clear-cache', (req, res) => {
  console.log('🧹 Cache clearing request received');

  // Headers para forzar no-cache en este endpoint
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'CF-Cache-Tag': 'cache-control',
    'X-Cache-Invalidate': 'products,alugueres,bikesul' // Indica qué invalidar
  });

  res.json({
    success: true,
    message: 'Cache clear signal sent to Cloudflare',
    invalidated_tags: ['products', 'alugueres', 'bikesul'],
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listo en puerto ${PORT}`);
  console.log(`💓 Health check disponible en: http://localhost:${PORT}/health`);
  console.log(`📊 Status check disponible en: http://localhost:${PORT}/status`);
  console.log(`📦 Productos disponibles en: http://localhost:${PORT}/products`);
  console.log(`🔄 Sincronización disponible en: http://localhost:${PORT}/sync-products`);
  console.log(`📈 Sync status disponible en: http://localhost:${PORT}/sync-status`);
  console.log(`🧪 CORS test disponible en: http://localhost:${PORT}/cors-test`);
  console.log(`🐛 Debug productos disponible en: http://localhost:${PORT}/debug-products`);
  console.log(`🧹 Clear cache disponible en: http://localhost:${PORT}/clear-cache (POST)`);
});
