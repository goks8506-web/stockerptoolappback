const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api', require('./Router/Inventory.router'));
app.use('/api', require('./Router/Godown.router'));
app.use('/api', require('./Router/Admin.router'));
app.use('/api', require('./Router/Analysis.router'));
app.use('/api', require('./Router/Search.router'));
app.use('/api', require('./Router/GodownAnalytics.router'));
app.use('/api', require('./Router/Booking.router'));
app.use('/api', require('./Router/Wdispatch.router'));
app.use('/api', require('./Router/Payments.router'));
app.use('/api', require('./Router/Delivery.router'));
app.use('/api', require('./Router/Company.router'));
app.use('/api/binvent', require('./Router/Binvent.router'));
app.use('/api/', require('./Router/Billing.router'));
app.use('/api', require('./Router/Purchase.router'));
app.use('/api', require('./Router/Reports.router'));
app.use('/api', require('./Router/AiBot.router'));

app.use((err, req, res, next) => {
  console.error('🔥 Error:', err.stack || err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
  try {
    await pool.query(`
      ALTER TABLE public.stock ADD COLUMN IF NOT EXISTS agent_name TEXT;
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS agent_name TEXT;
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS added_by TEXT;
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS customer_name TEXT;

      -- Support fractional cases & loose piece equivalents in database
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE public.stock ALTER COLUMN current_cases TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.stock ALTER COLUMN taken_cases TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.stock_history ALTER COLUMN cases TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.stock_history ALTER COLUMN per_case_total TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.purchase_dispatch_logs ALTER COLUMN dispatched_cases TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.purchase_dispatch_logs ALTER COLUMN dispatched_qty TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.dispatch_logs ALTER COLUMN dispatched_cases TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        BEGIN
          ALTER TABLE public.dispatch_logs ALTER COLUMN dispatched_qty TYPE NUMERIC(12, 2);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END $$;

      -- Ensure columns in stock_history and stock exist before any updates
      CREATE TABLE IF NOT EXISTS public.stock_history (
        id BIGSERIAL PRIMARY KEY,
        stock_id INTEGER REFERENCES public.stock(id) ON DELETE CASCADE,
        action VARCHAR(10) CHECK (action IN ('added', 'taken')),
        cases NUMERIC(12, 2) NOT NULL,
        per_case_total NUMERIC(12, 2) NOT NULL,
        agent_name TEXT,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS purchase_id INTEGER;
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS customer_name TEXT;
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS agent_name TEXT;
      ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS is_billed BOOLEAN DEFAULT FALSE;
      ALTER TABLE public.stock ADD COLUMN IF NOT EXISTS agent_name TEXT;

      -- Ensure purchase_dispatch_logs table and all columns exist
      CREATE TABLE IF NOT EXISTS public.purchase_dispatch_logs (
        id SERIAL PRIMARY KEY,
        purchase_id INTEGER REFERENCES public.purchases(id) ON DELETE CASCADE,
        product_index INTEGER NOT NULL DEFAULT 0,
        product_name TEXT NOT NULL DEFAULT '',
        brand TEXT DEFAULT '',
        dispatched_cases NUMERIC(12, 2) NOT NULL DEFAULT 0,
        dispatched_qty NUMERIC(12, 2) NOT NULL DEFAULT 0,
        godown TEXT DEFAULT '',
        transport_name TEXT,
        lr_number TEXT,
        allocated_by TEXT,
        dispatched_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS product_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS product_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT '';
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS dispatched_cases NUMERIC(12, 2) NOT NULL DEFAULT 0;
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS dispatched_qty NUMERIC(12, 2) NOT NULL DEFAULT 0;
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS godown TEXT DEFAULT '';
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS transport_name TEXT;
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS lr_number TEXT;
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS allocated_by TEXT;
      ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP DEFAULT NOW();

      -- Deduplicate brand table if needed and ensure unique index
      CREATE TABLE IF NOT EXISTS public.brand (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        agent_name VARCHAR(100)
      );
      DELETE FROM public.brand a USING public.brand b
      WHERE a.id > b.id AND LOWER(TRIM(a.name)) = LOWER(TRIM(b.name));
      CREATE UNIQUE INDEX IF NOT EXISTS brand_name_unique_idx ON public.brand (name);
    `);
  } catch (err) {
    // Non-blocking schema check
  }
  console.log(`Server running on port ${PORT}`);
});