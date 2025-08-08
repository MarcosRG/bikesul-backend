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

// Middleware CORS global - MEJORADO para compatibilidad total
app.use(cors({
  origin: function (origin, callback) {
    // Permitir llamadas sin origin (como Postman y curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.log(`❌ CORS blocked for origin: ${origin}`);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'User-Agent',
    'Cache-Control',     // ← Para cache warming
    'Pragma',            // ← Para cache control
    'Accept',            // ← Para content negotiation
    'Accept-Encoding',   // ← Para compresión
    'Accept-Language',   // ← Para i18n
    'X-Requested-With',  // ← Para XHR requests
    'Origin',            // ← Header origen
    'Referer',           // ← Header referencia
    'If-None-Match',     // ← Para ETag validation
    'If-Modified-Since'  // ← Para Last-Modified validation
  ],
  exposedHeaders: [
    'Cache-Control',
    'ETag',
    'Last-Modified',
    'X-Cache-Status',
    'CF-Cache-Tag'
  ],
  credentials: true,
  optionsSuccessStatus: 200 // Para navegadores legacy
}));

// Middleware para manejar OPTIONS (preflight) en todas las rutas
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

// ID de la categoría ALUGUERES en WooCommerce
const ALUGUERES_CATEGORY_ID = 319;

// Función auxiliar para extrair pricing ACF desde meta_data
function extractACFPricing(acfData, metaData = []) {
  let pricing = {};
  
  // Primero intentar desde ACF directo
  if (acfData && typeof acfData === 'object') {
    if (acfData.precio_1_2) pricing.precio_1_2 = acfData.precio_1_2;
    if (acfData.precio_3_6) pricing.precio_3_6 = acfData.precio_3_6;
    if (acfData.precio_7_mais) pricing.precio_7_mais = acfData.precio_7_mais;
  }
  
  // Si no hay pricing en ACF, buscar en meta_data
  if (Object.keys(pricing).length === 0 && Array.isArray(metaData)) {
    metaData.forEach(meta => {
      if (meta.key === 'precio_1_2' || meta.key === '_precio_1_2') {
        pricing.precio_1_2 = meta.value;
      }
      if (meta.key === 'precio_3_6' || meta.key === '_precio_3_6') {
        pricing.precio_3_6 = meta.value;
      }
      if (meta.key === 'precio_7_mais' || meta.key === '_precio_7_mais') {
        pricing.precio_7_mais = meta.value;
      }
    });
  }
  
  return pricing;
}

// Función para procesar y transformar productos para compatibilidad total
function processProductForResponse(dbProduct) {
  try {
    // Parsear campos JSON
    const categories = JSON.parse(dbProduct.categories || '[]');
    const images = JSON.parse(dbProduct.images || '[]');
    const acfData = JSON.parse(dbProduct.acf_data || '{}');
    const metaData = JSON.parse(dbProduct.meta_data || '[]');
    const variationsIds = JSON.parse(dbProduct.variations_ids || '[]');

    // Extraer categoria principal (excluyendo "alugueres")
    const subcategory = categories.find(cat => cat.slug && cat.slug !== "alugueres");
    const primaryCategory = subcategory ? subcategory.slug : 'general';

    // Obtener imagen principal
    const mainImage = images.length > 0 && images[0]?.src 
      ? images[0].src 
      : '/placeholder.svg';

    // Extraer pricing ACF
    const acfPricing = extractACFPricing(acfData, metaData);
    
    // Calcular precio basado en ACF o precio regular
    let calculatedPrice = parseFloat(dbProduct.price || 0);
    if (acfPricing.precio_1_2) {
      calculatedPrice = parseFloat(acfPricing.precio_1_2);
    } else if (dbProduct.regular_price) {
      calculatedPrice = parseFloat(dbProduct.regular_price);
    }

    // Producto procesado compatible con frontend
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
      // Campos adicionales para compatibilidad
      sku: dbProduct.sku || '',
      category: primaryCategory
    };
  } catch (error) {
    console.error('Error procesando producto:', error);
    // Fallback básico si hay error en el procesamiento
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

// 🔹 Endpoint de saúde con cache headers
app.get('/health', (req, res) => {
  // Headers CORS explícitos para health check
  res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Pragma, Accept, Accept-Encoding, User-Agent, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');

  // Headers para health check (cache corto)
  res.set({
    'Cache-Control': 'public, max-age=60, s-maxage=120', // 1min browser, 2min CDN
    'CF-Cache-Tag': 'health,system',
    'X-Cache-Status': 'CACHE-ENABLED',
    'X-CORS-Debug': 'explicit-headers-set'
  });

  console.log(`✅ Health check successful from ${req.get('Origin') || 'no-origin'}`);

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

// 🔹 Sincronizar produtos desde WooCommerce (SOLO ALUGUERES)
app.get('/sync-products', async (req, res) => {
  try {
    console.log('🔄 Iniciando sincronização de produtos ALUGUERES...');
    
    // Sincronizar SOLO productos de la categoría ALUGUERES
    const response = await axios.get(`${process.env.WOOCOMMERCE_API_BASE}/products`, {
      params: {
        category: ALUGUERES_CATEGORY_ID,
        status: 'publish',
        per_page: 100
      },
      auth: {
        username: process.env.WOOCOMMERCE_CONSUMER_KEY,
        password: process.env.WOOCOMMERCE_CONSUMER_SECRET,
      }
    });

    const products = response.data;
    let syncedCount = 0;
    let errorCount = 0;

    console.log(`📦 ${products.length} produtos ALUGUERES obtidos do WooCommerce`);

    for (let product of products) {
      try {
        // Solo sincronizar si el producto pertenece a ALUGUERES
        const belongsToAlugueres = product.categories?.some(cat => cat.id === ALUGUERES_CATEGORY_ID);
        
        if (!belongsToAlugueres) {
          console.log(`⏭️ Produto ${product.id} não pertence a ALUGUERES, saltando...`);
          continue;
        }

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
            updated_at = NOW()
        `, [
          product.id,
          product.name,
          product.type || 'simple',
          product.status || 'publish',
          product.price || 0,
          product.regular_price || 0,
          product.stock_quantity || 0,
          product.stock_status || 'instock',
          JSON.stringify(product.categories || []),
          JSON.stringify(product.images || []),
          product.short_description || '',
          product.description || '',
          JSON.stringify(product.variations || []),
          JSON.stringify(product.acf || {}),
          JSON.stringify(product.meta_data || [])
        ]);
        
        syncedCount++;
        console.log(`✅ Produto ${product.id} - ${product.name} sincronizado`);
      } catch (productError) {
        console.error(`❌ Erro sincronizando produto ${product.id}:`, productError.message);
        errorCount++;
      }
    }

    const result = {
      success: true,
      message: `Sincronização concluída: ${syncedCount} produtos ALUGUERES sincronizados`,
      synced_count: syncedCount,
      total_products: products.length,
      error_count: errorCount,
      timestamp: new Date().toISOString(),
      category_filter: 'ALUGUERES (ID: 319)',
      cache_invalidated: true // Indica que el cache debe invalidarse
    };

    // Headers para invalidar cache después de sync
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Cache-Invalidate': 'products,alugueres,bikesul',
      'X-Sync-Complete': 'true',
      'CF-Cache-Tag': 'sync,system'
    });

    console.log('✅ Sincronização completada:', result);
    res.json(result);
  } catch (err) {
    console.error('❌ Error completo na sincronização:', err.response?.data || err.message);
    res.status(500).json({ 
      success: false,
      error: err.response?.data || err.message,
      message: 'Erro na sincronização de produtos ALUGUERES'
    });
  }
});

// 🔹 Obtener produtos (SOLO ALUGUERES filtrados) con cache headers para Cloudflare
app.get('/products', async (req, res) => {
  try {
    const { category } = req.query;

    // Headers CORS explícitos para productos
    res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Pragma, Accept, Accept-Encoding, User-Agent, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');

    // Headers de cache para Cloudflare (Cache global instantáneo)
    res.set({
      'Cache-Control': 'public, max-age=300, s-maxage=900', // 5min browser, 15min CDN
      'CF-Cache-Tag': 'products,alugueres,bikesul', // Tags para invalidación selectiva
      'Vary': 'Accept-Encoding', // Compresión diferenciada
      'ETag': `"products-${Date.now()}"`, // ETag para validación
      'Last-Modified': new Date().toUTCString(), // Última modificación
      'X-Cache-Status': 'CACHE-ENABLED', // Header de debug
      'X-Content-Type-Options': 'nosniff', // Seguridad
      'X-Frame-Options': 'DENY', // Seguridad
      'X-CORS-Debug': 'explicit-headers-set'
    });
    
    let query = `
      SELECT * FROM products 
      WHERE categories::text LIKE '%"id":${ALUGUERES_CATEGORY_ID}%' 
      AND status = 'publish'
      AND stock_status = 'instock'
      AND stock_quantity > 0
    `;
    
    // Filtro adicional por categoria específica si se proporciona
    if (category && category !== 'all') {
      query += ` AND categories::text LIKE '%"slug":"${category}"%'`;
    }
    
    query += ` ORDER BY created_at DESC`;
    
    console.log(`🔍 Consultando produtos ALUGUERES${category ? ` categoria: ${category}` : ''}...`);
    
    const result = await db.query(query);
    
    // Procesar cada producto para compatibilidad total
    const processedProducts = result.rows.map(processProductForResponse);
    
    console.log(`📦 ${processedProducts.length} produtos ALUGUERES retornados`);
    
    res.json(processedProducts);
  } catch (error) {
    console.error('❌ Error obteniendo produtos:', error.message);
    res.status(500).json({ 
      error: 'Error al obtener produtos ALUGUERES',
      details: error.message 
    });
  }
});

// 🔹 Obtener produto específico por ID con cache headers
app.get('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🔍 Buscando produto ${id}...`);

    // Headers de cache para producto específico (cache más largo)
    res.set({
      'Cache-Control': 'public, max-age=600, s-maxage=1800', // 10min browser, 30min CDN
      'CF-Cache-Tag': `product-${id},products,alugueres,bikesul`,
      'Vary': 'Accept-Encoding',
      'ETag': `"product-${id}-${Date.now()}"`,
      'Last-Modified': new Date().toUTCString(),
      'X-Cache-Status': 'CACHE-ENABLED'
    });
    
    const result = await db.query(
      `SELECT * FROM products 
       WHERE (woocommerce_id = $1 OR id = $1) 
       AND categories::text LIKE '%"id":${ALUGUERES_CATEGORY_ID}%' 
       AND status = 'publish'`,
      [id]
    );
    
    if (result.rows.length === 0) {
      console.log(`⚠️ Produto ${id} não encontrado em ALUGUERES`);
      return res.status(404).json({ 
        error: 'Produto não encontrado na categoria ALUGUERES',
        id: id 
      });
    }
    
    const processedProduct = processProductForResponse(result.rows[0]);
    
    console.log(`✅ Produto ${id} encontrado: ${processedProduct.name}`);
    res.json(processedProduct);
  } catch (error) {
    console.error(`❌ Error buscando produto ${req.params.id}:`, error.message);
    res.status(500).json({ 
      error: 'Error al buscar produto',
      details: error.message 
    });
  }
});

// 🔹 Endpoint para verificar status da sincronização
app.get('/sync-status', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*) as total_products,
        COUNT(CASE WHEN status = 'publish' THEN 1 END) as published_products,
        COUNT(CASE WHEN stock_quantity > 0 THEN 1 END) as in_stock_products,
        MAX(updated_at) as last_sync
      FROM products 
      WHERE categories::text LIKE '%"id":${ALUGUERES_CATEGORY_ID}%'
    `);
    
    res.json({
      category: 'ALUGUERES',
      category_id: ALUGUERES_CATEGORY_ID,
      ...result.rows[0],
      database_status: 'connected'
    });
  } catch (error) {
    console.error('❌ Error verificando status:', error.message);
    res.status(500).json({ 
      error: 'Error verificando status da sincronização',
      details: error.message 
    });
  }
});

// 🔹 Endpoint de test CORS para debugging
app.get('/cors-test', (req, res) => {
  console.log('🧪 CORS Test request received');

  // Headers CORS explícitos máximos
  res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Accept, Accept-Encoding, User-Agent, X-Requested-With, Origin, Referer, If-None-Match, If-Modified-Since');
  res.header('Access-Control-Expose-Headers', 'Cache-Control, ETag, Last-Modified, X-Cache-Status, CF-Cache-Tag');
  res.header('Access-Control-Allow-Credentials', 'true');

  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-CORS-Test': 'success',
    'X-CORS-Debug': 'test-endpoint'
  });

  res.json({
    success: true,
    message: 'CORS Test successful',
    request_info: {
      origin: req.get('Origin'),
      user_agent: req.get('User-Agent'),
      method: req.method,
      headers: req.headers,
      query: req.query
    },
    timestamp: new Date().toISOString()
  });
});

// 🔹 Endpoint para limpeza de cache Cloudflare (útil após sincronização)
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

// 🔹 Start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 BikesSul Backend (ALUGUERES Filter) rodando na porta ${PORT}`);
  console.log(`📂 Filtrando apenas categoria ALUGUERES (ID: ${ALUGUERES_CATEGORY_ID})`);
});
