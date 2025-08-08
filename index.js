require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// Orígenes permitidos
const allowedOrigins = [
  'https://app.bikesultoursgest.com',
  'https://api.bikesultoursgest.com'
];

// Middleware CORS global - MEJORADO
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.log(`❌ CORS blocked for origin: ${origin}`);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'User-Agent', 'Cache-Control', 'Pragma',
    'Accept', 'Accept-Encoding', 'Accept-Language', 'X-Requested-With',
    'Origin', 'Referer', 'If-None-Match', 'If-Modified-Since'
  ],
  exposedHeaders: ['Cache-Control', 'ETag', 'Last-Modified', 'X-Cache-Status', 'CF-Cache-Tag'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.options('*', cors());

// Middleware de logging para debugging CORS
app.use((req, res, next) => {
  const origin = req.get('Origin');
  const method = req.method;
  if (method === 'OPTIONS' || origin) {
    console.log(`🌐 CORS Request: ${method} ${req.path} from ${origin || 'no-origin'}`);
    console.log(`📝 Headers: ${JSON.stringify(req.headers, null, 2)}`);
  }
  next();
});

app.use(express.json());

// PostgreSQL
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ID de la categoría ALUGUERES
const ALUGUERES_CATEGORY_ID = 319;

// Función auxiliar para extraer pricing ACF
function extractACFPricing(acfData, metaData = []) {
  let pricing = {};
  if (acfData && typeof acfData === 'object') {
    if (acfData.precio_1_2) pricing.precio_1_2 = acfData.precio_1_2;
    if (acfData.precio_3_6) pricing.precio_3_6 = acfData.precio_3_6;
    if (acfData.precio_7_mais) pricing.precio_7_mais = acfData.precio_7_mais;
  }
  if (Object.keys(pricing).length === 0 && Array.isArray(metaData)) {
    metaData.forEach(meta => {
      if (meta.key === 'precio_1_2' || meta.key === '_precio_1_2') pricing.precio_1_2 = meta.value;
      if (meta.key === 'precio_3_6' || meta.key === '_precio_3_6') pricing.precio_3_6 = meta.value;
      if (meta.key === 'precio_7_mais' || meta.key === '_precio_7_mais') pricing.precio_7_mais = meta.value;
    });
  }
  return pricing;
}

// Función para procesar productos
function processProductForResponse(dbProduct) {
  try {
    const categories = JSON.parse(dbProduct.categories || '[]');
    const images = JSON.parse(dbProduct.images || '[]');
    const acfData = JSON.parse(dbProduct.acf_data || '{}');
    const metaData = JSON.parse(dbProduct.meta_data || '[]');
    const variationsIds = JSON.parse(dbProduct.variations_ids || '[]');

    const subcategory = categories.find(cat => cat.slug && cat.slug !== "alugueres");
    const primaryCategory = subcategory ? subcategory.slug : 'general';

    const mainImage = images.length > 0 && images[0]?.src ? images[0].src : '/placeholder.svg';

    const acfPricing = extractACFPricing(acfData, metaData);
    let calculatedPrice = parseFloat(dbProduct.price || 0);
    if (acfPricing.precio_1_2) calculatedPrice = parseFloat(acfPricing.precio_1_2);
    else if (dbProduct.regular_price) calculatedPrice = parseFloat(dbProduct.regular_price);

    return {
      id: dbProduct.woocommerce_id ? dbProduct.woocommerce_id.toString() : dbProduct.id.toString(),
      name: dbProduct.name,
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
      sku: dbProduct.sku || '',
      category: primaryCategory
    };
  } catch (error) {
    console.error('Error procesando producto:', error);
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

// Health check
app.get('/health', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Pragma, Accept, Accept-Encoding, User-Agent, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.set({
    'Cache-Control': 'public, max-age=60, s-maxage=120',
    'CF-Cache-Tag': 'health,system',
    'X-Cache-Status': 'CACHE-ENABLED',
    'X-CORS-Debug': 'explicit-headers-set'
  });
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'BikesSul Backend - Alugueres Filter',
    version: '2.0.1',
    cors_debug: {
      origin: req.get('Origin'),
      user_agent: req.get('User-Agent'),
      headers_received: Object.keys(req.headers).length
    }
  });
});

// 🔹 Sincronizar produtos SOLO ALUGUERES - Mejorado
app.get('/sync-products', async (req, res) => {
  try {
    console.log('🔄 Iniciando sincronização de produtos ALUGUERES...');
    const response = await axios.get(`${process.env.WOOCOMMERCE_API_BASE}/products`, {
      params: { category: ALUGUERES_CATEGORY_ID, status: 'publish', per_page: 100 },
      auth: {
        username: process.env.WOOCOMMERCE_CONSUMER_KEY,
        password: process.env.WOOCOMMERCE_CONSUMER_SECRET,
      }
    });

    const products = response.data;
    let syncedCount = 0, errorCount = 0;
    console.log(`📦 ${products.length} produtos ALUGUERES obtidos do WooCommerce`);

    for (let product of products) {
      try {
        const belongsToAlugueres = product.categories?.some(cat => Number(cat.id) === ALUGUERES_CATEGORY_ID);
        if (!belongsToAlugueres) continue;

        // Normalización
        product.status = (product.status || 'publish').toLowerCase();
        product.stock_status = (product.stock_status || 'instock').toLowerCase();
        product.stock_quantity = product.stock_quantity != null ? Number(product.stock_quantity) : 1;
        product.categories = (product.categories || []).map(cat => ({ ...cat, id: Number(cat.id) }));

        await db.query(
          `INSERT INTO products (
            woocommerce_id, name, type, status, price, regular_price,
            stock_quantity, stock_status, categories, images,
            short_description, description, variations_ids, acf_data,
            meta_data, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, NOW(), NOW()
          )
          ON CONFLICT (woocommerce_id) DO UPDATE SET
            name = EXCLUDED.name, type = EXCLUDED.type, status = EXCLUDED.status,
            price = EXCLUDED.price, regular_price = EXCLUDED.regular_price,
            stock_quantity = EXCLUDED.stock_quantity, stock_status = EXCLUDED.stock_status,
            categories = EXCLUDED.categories, images = EXCLUDED.images,
            short_description = EXCLUDED.short_description, description = EXCLUDED.description,
            variations_ids = EXCLUDED.variations_ids, acf_data = EXCLUDED.acf_data,
            meta_data = EXCLUDED.meta_data, updated_at = NOW()
        `, [
          product.id, product.name, product.type || 'simple', product.status,
          Number(product.price || 0), Number(product.regular_price || 0),
          product.stock_quantity, product.stock_status,
          JSON.stringify(product.categories), JSON.stringify(product.images || []),
          product.short_description || '', product.description || '',
          JSON.stringify(product.variations || []), JSON.stringify(product.acf || {}),
          JSON.stringify(product.meta_data || [])
        ]);

        syncedCount++;
      } catch (err) {
        console.error(`❌ Erro sincronizando produto ${product.id}:`, err.message);
        errorCount++;
      }
    }

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Cache-Invalidate': 'products,alugueres,bikesul',
      'X-Sync-Complete': 'true',
      'CF-Cache-Tag': 'sync,system'
    });
    res.json({
      success: true,
      message: `Sincronização concluída: ${syncedCount} produtos ALUGUERES sincronizados`,
      synced_count: syncedCount, total_products: products.length,
      error_count: errorCount, timestamp: new Date().toISOString(),
      category_filter: 'ALUGUERES (ID: 319)', cache_invalidated: true
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, message: 'Erro na sincronização de produtos ALUGUERES' });
  }
});

// 🔹 Obtener produtos (ALUGUERES) - Filtro flexible
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
      'Last-Modified': new Date().toUTCString(),
      'X-Cache-Status': 'CACHE-ENABLED',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-CORS-Debug': 'explicit-headers-set'
    });

    let query = `
      SELECT * FROM products 
      WHERE categories::text ILIKE '%"id":${ALUGUERES_CATEGORY_ID}%' 
      AND LOWER(status) = 'publish'
      AND LOWER(stock_status) = 'instock'
      AND COALESCE(stock_quantity, 0) > 0
    `;
    if (category && category !== 'all') {
      query += ` AND categories::text ILIKE '%"slug":"${category}"%'`;
    }
    query += ` ORDER BY created_at DESC`;

    const result = await db.query(query);
    res.json(result.rows.map(processProductForResponse));
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener produtos ALUGUERES', details: error.message });
  }
});

// Start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 BikesSul Backend (ALUGUERES Filter) rodando na porta ${PORT}`);
});
