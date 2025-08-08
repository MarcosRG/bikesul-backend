// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// Orígenes permitidos (ajusta si hace falta)
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

// OPTIONS global
app.options('*', cors());

// Logging middleware para debug
app.use((req, res, next) => {
  const origin = req.get('Origin');
  const method = req.method;
  if (method === 'OPTIONS' || origin) {
    console.log(`🌐 ${method} ${req.path} from ${origin || 'no-origin'}`);
  }
  next();
});

app.use(express.json());

// Pool Postgres (Neon)
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Config
const PORT = process.env.PORT || 4000;
const ALUGUERES_CATEGORY_ID = parseInt(process.env.ALUGUERES_CATEGORY_ID || '319', 10);

// --- Utiles ---
function parseJSONSafe(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (err) { return fallback; }
  }
  return fallback;
}

// Extrae precios ACF (igual que tu función previa, robusta)
function extractACFPricing(acfData, metaData = []) {
  const pricing = {};
  if (acfData && typeof acfData === 'object') {
    if (acfData.precio_1_2) pricing.precio_1_2 = acfData.precio_1_2;
    if (acfData.precio_3_6) pricing.precio_3_6 = acfData.precio_3_6;
    if (acfData.precio_7_mais) pricing.precio_7_mais = acfData.precio_7_mais;
  }
  if (Object.keys(pricing).length === 0 && Array.isArray(metaData)) {
    metaData.forEach(meta => {
      const key = meta.key || meta.name || '';
      const val = meta.value !== undefined ? meta.value : meta.val;
      if (!val) return;
      if (key === 'precio_1_2' || key === '_precio_1_2') pricing.precio_1_2 = val;
      if (key === 'precio_3_6' || key === '_precio_3_6') pricing.precio_3_6 = val;
      if (key === 'precio_7_mais' || key === '_precio_7_mais') pricing.precio_7_mais = val;
    });
  }
  return pricing;
}

// Procesa fila DB -> objeto API
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

// --- Helper: fetch variations from WooCommerce (paginado) ---
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
        timeout: 30_000
      });
      if (!Array.isArray(resp.data) || resp.data.length === 0) break;
      all = all.concat(resp.data);
      if (resp.data.length < per_page) break;
      page++;
    }
  } catch (err) {
    console.error(`❌ Error fetching variations for product ${productId}:`, err.response?.data || err.message || err);
    // Devolver lo que tengamos (posible vacío)
  }
  return all;
}

// --- Endpoint: sync-products (trae variaciones y actualiza variations_stock) ---
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
    // intentar crear índice GIN para mejorar búsquedas JSONB (silencioso si no se puede)
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
        timeout: 30_000
      });

      const products = Array.isArray(resp.data) ? resp.data : [];
      if (products.length === 0) break;
      totalFetched += products.length;

      for (const product of products) {
        try {
          // Double-check: si no pertenece a ALUGUERES, saltar (precaución)
          const belongs = Array.isArray(product.categories) && product.categories.some(c => Number(c.id) === ALUGUERES_CATEGORY_ID);
          if (!belongs) {
            console.log(`⏭️ Producto ${product.id} no pertenece a ALUGUERES, saltando.`);
            continue;
          }

          // Si es variable, traer variaciones y montar variations_stock
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
            // no es variable -> leave empty or use parent's data
            variationsIds = product.variations || [];
            variationsStock = [];
          }

          // Calcular stock agregado: suma de stock_quantity de variaciones cuando exista
          let aggregatedStock = 0;
          if (variationsStock.length > 0) {
            aggregatedStock = variationsStock.reduce((acc, vs) => {
              const q = Number.isFinite(Number(vs.stock_quantity)) ? Number(vs.stock_quantity) : 0;
              return acc + q;
            }, 0);
          } else {
            aggregatedStock = product.stock_quantity !== undefined && product.stock_quantity !== null ? Number(product.stock_quantity) : 0;
          }

          // Insert / Update en DB (parametrizado)
          const q = `
            INSERT INTO products (
              woocommerce_id, name, type, status, price, regular_price,
              stock_quantity, stock_status, categories, images,
              short_description, description, variations_ids, acf_data,
              meta_data, variations_stock, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9, $10,
              $11, $12, $13, $14,
              $15, $16, NOW(), NOW()
            )
            ON CONFLICT (woocommerce_id) DO UPDATE SET
              name = EXCLUDED.name,
              type = EXCLUDED.type,
              status = EXCLUDED.status,
              price = EXCLUDED.price,
              regular_price = EXCLUDED.regular_price,
              stock_quantity = EXCLUDED.stock_quantity,
              stock_status = EXCLUDED.stock_status,
              categories = EXCLUDED.categories,
              images = EXCLUDED.images,
              short_description = EXCLUDED.short_description,
              description = EXCLUDED.description,
              variations_ids = EXCLUDED.variations_ids,
              acf_data = EXCLUDED.acf_data,
              meta_data = EXCLUDED.meta_data,
              variations_stock = EXCLUDED.variations_stock,
              updated_at = NOW()
          `;

          const params = [
            product.id,
            product.name || '',
            product.type || 'simple',
            product.status || 'publish',
            product.price || 0,
            product.regular_price || 0,
            aggregatedStock,
            product.stock_status || 'instock',
            JSON.stringify(product.categories || []),
            JSON.stringify(product.images || []),
            product.short_description || '',
            product.description || '',
            JSON.stringify(variationsIds || []),
            JSON.stringify(product.acf || {}),
            JSON.stringify(product.meta_data || []),
            JSON.stringify(variationsStock || [])
          ];

          await db.query(q, params);
          totalSynced++;
          console.log(`✅ Sincronizado producto ${product.id} (${product.name}) - variaciones: ${variationsIds.length}`);
        } catch (prodErr) {
          totalErrors++;
          console.error(`❌ Error procesando producto ${product.id}:`, prodErr.response?.data || prodErr.message || prodErr);
        }
      } // for products

      if (products.length < per_page) break;
      page++;
    } // while pages

    const resultSummary = {
      success: true,
      total_fetched: totalFetched,
      total_synced: totalSynced,
      total_errors: totalErrors,
      timestamp: new Date().toISOString(),
      category: `ALUGUERES (ID ${ALUGUERES_CATEGORY_ID})`
    };

    // Respuesta
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Cache-Invalidate': 'products,alugueres,bikesul',
      'X-Sync-Complete': 'true'
    });
    console.log('✅ Sincronización completada', resultSummary);
    return res.json(resultSummary);

  } catch (err) {
    console.error('❌ Sincronización falló:', err.response?.data || err.message || err);
    return res.status(500).json({
      success: false,
      error: err.response?.data || err.message || String(err)
    });
  }
});

// --- ENDPOINT /products (lectura) ---
app.get('/products', async (req, res) => {
  try {
    const { category } = req.query;

    res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Pragma, Accept, Accept-Encoding, User-Agent, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');

    res.set({
      'Cache-Control': 'public, max-age=300, s-maxage=900',
      'CF-Cache-Tag': 'products,alugueres,bikesul',
      'Vary': 'Accept-Encoding',
      'ETag': `"products-${Date.now()}"`,
      'Last-Modified': new Date().toUTCString()
    });

    let sql = `
      SELECT * FROM products
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(categories) AS cat
        WHERE (cat->>'id')::int = $1
      )
      AND LOWER(status) = 'publish'
    `;
    const params = [ALUGUERES_CATEGORY_ID];

    if (category && category !== 'all') {
      params.push(String(category).toLowerCase());
      sql += `
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(categories) AS cat2
          WHERE LOWER(cat2->>'slug') = $${params.length}
        )
      `;
    }
    sql += ` ORDER BY created_at DESC`;

    const result = await db.query(sql, params);
    const processed = result.rows.map(processProductForResponse);
    return res.json(processed);
  } catch (err) {
    console.error('❌ Error obteniendo productos:', err.message || err);
    return res.status(500).json({ error: 'Error al obtener productos', details: err.message || String(err) });
  }
});

// --- ENDPOINT /products/:id (lectura) ---
app.get('/products/:id', async (req, res) => {
  try {
    const id = req.params.id;
    res.set({
      'Cache-Control': 'public, max-age=600, s-maxage=1800',
      'CF-Cache-Tag': `product-${id},products,alugueres,bikesul`,
    });

    const sql = `
      SELECT * FROM products
      WHERE (woocommerce_id = $1 OR id = $1)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(categories) AS cat
        WHERE (cat->>'id')::int = $2
      )
      AND LOWER(status) = 'publish'
    `;
    const result = await db.query(sql, [id, ALUGUERES_CATEGORY_ID]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado en ALUGUERES', id });
    }
    const processed = processProductForResponse(result.rows[0]);
    return res.json(processed);
  } catch (err) {
    console.error(`❌ Error buscando producto ${req.params.id}:`, err.message || err);
    return res.status(500).json({ error: 'Error al buscar producto', details: err.message || String(err) });
  }
});

// --- DEBUG /debug-products ---
app.get('/debug-products', async (req, res) => {
  try {
    const qTotal = await db.query('SELECT COUNT(*) as total FROM products');
    const total = parseInt(qTotal.rows[0].total, 10);

    const qAlug = await db.query(
      `SELECT COUNT(*) as alug_total FROM products
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(categories) AS cat
         WHERE (cat->>'id')::int = $1
       )`, [ALUGUERES_CATEGORY_ID]);

    const qSamples = await db.query(
      `SELECT woocommerce_id, name, status, stock_quantity, variations_ids, variations_stock, categories
       FROM products
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(categories) AS cat
         WHERE (cat->>'id')::int = $1
       )
       ORDER BY created_at DESC
       LIMIT 10`, [ALUGUERES_CATEGORY_ID]);

    const debug = {
      total_products_in_db: total,
      alugueres_products_total: parseInt(qAlug.rows[0].alug_total, 10),
      sample_products: qSamples.rows,
      timestamp: new Date().toISOString()
    };
    return res.json(debug);
  } catch (err) {
    console.error('❌ Error en debug-products:', err.message || err);
    return res.status(500).json({ error: 'Error en debug-products', details: err.message || String(err) });
  }
});

// --- SYNC STATUS ---
app.get('/sync-status', async (req, res) => {
  try {
    const q = await db.query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE LOWER(status) = 'publish') AS published,
             COUNT(*) FILTER (WHERE stock_quantity > 0) AS in_stock,
             MAX(updated_at) as last_sync
      FROM products
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(categories) AS cat
        WHERE (cat->>'id')::int = $1
      )`, [ALUGUERES_CATEGORY_ID]);

    return res.json({
      category: 'ALUGUERES',
      category_id: ALUGUERES_CATEGORY_ID,
      total_products: parseInt(q.rows[0].total, 10),
      published_products: parseInt(q.rows[0].published, 10),
      in_stock_products: parseInt(q.rows[0].in_stock, 10),
      last_sync: q.rows[0].last_sync
    });
  } catch (err) {
    console.error('❌ Error en sync-status:', err.message || err);
    return res.status(500).json({ error: 'Error en sync-status', details: err.message || String(err) });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🚀 BikesSul Backend (ALUGUERES Filter) escuchando en puerto ${PORT}`);
  console.log(`📂 Filtrando categoría ALUGUERES (ID: ${ALUGUERES_CATEGORY_ID})`);
});
