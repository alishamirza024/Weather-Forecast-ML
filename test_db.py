import psycopg2
import os
from dotenv import load_dotenv

load_dotenv()

try:
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    print("✅ Connected to Supabase successfully!")
    conn.close()
except Exception as e:
    print("❌ Connection failed:", e)