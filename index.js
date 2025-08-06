require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Sincronizar productos de WooCommerce a Neon
app.get('/sync-products', async (req, res) => {
  try {
    const response = await axios.get(`${process.env.WOOCOMMERCE_API_BASE}/products`, {
      auth: {
        username: process.env.WOOCOMMERCE_CONSUMER_KEY,
        password: process.env.WOOCOMMERCE_CONSUMER_SECRET,
      }
    });

    const products = response.data;

    for (let product of products) {
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
    }

    res.json({ message: 'Productos sincronizados exitosamente' });
  } catch (error) {
    console.error('Error sincronizando productos:', error.message);
    res.status(500).json({ error: 'Error al sincronizar productos' });
  }
});

// Obtener productos
app.get('/products', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo productos:', error.message);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor backend escuchando en puerto ${PORT}`);
});

