"""
Load Dataset into MySQL Database
"""

import mysql.connector
import pandas as pd
import numpy as np
import os

# ── CONFIG ──────────────────────────────────────
DB_CONFIG = {
    "host":     "localhost",
    "port":     3306,
    "user":     "root",
    "password": "Root@123",
}
DB_NAME        = "weather_forecast_db"
DATASET_PATH   = "data/raw/india_weather_dataset.csv"
CHUNK_SIZE     = 2000
MONTHS_TO_LOAD = 12


def get_connection(with_db=True):
    config = DB_CONFIG.copy()
    if with_db:
        config["database"] = DB_NAME

    return mysql.connector.connect(
        **config,
        connection_timeout=600,
        autocommit=False
    )

def create_database():
    print("  Creating database...")
    conn   = get_connection(with_db=False)
    cursor = conn.cursor()
    cursor.execute(f"CREATE DATABASE IF NOT EXISTS {DB_NAME}")
    conn.commit()
    cursor.close()
    conn.close()
    print(f"  Database '{DB_NAME}' ready.")


def create_tables():
    print("\n  Creating tables...")
    conn   = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS weather_data (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            datetime           DATETIME NOT NULL,
            city               VARCHAR(50) NOT NULL,
            climate_zone       VARCHAR(50),
            latitude           FLOAT,
            longitude          FLOAT,
            temperature_c      FLOAT,
            humidity_pct       FLOAT,
            precipitation_mm   FLOAT,
            wind_speed_kmh     FLOAT,
            wind_direction_deg FLOAT,
            pressure_hpa       FLOAT,
            cloud_cover_pct    FLOAT,
            feels_like_c       FLOAT,
            weather_code       INT,
            rain_flag          TINYINT,
            season             VARCHAR(20),
            month              INT,
            hour               INT,
            year               INT,
            INDEX idx_city    (city),
            INDEX idx_datetime(datetime),
            INDEX idx_city_dt (city, datetime)
        )
    """)
    print("    created  weather_data")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            city_name          VARCHAR(100) NOT NULL,
            searched_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
            predicted_temp     FLOAT,
            predicted_humidity FLOAT,
            predicted_rain     TINYINT,
            rain_probability   FLOAT,
            confidence_score   FLOAT,
            model_used         VARCHAR(50),
            forecast_day       INT DEFAULT 1
        )
    """)
    print("    created  predictions")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS search_history (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            city_name   VARCHAR(100) NOT NULL,
            searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            was_found   TINYINT DEFAULT 1,
            response_ms INT
        )
    """)
    print("    created  search_history")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS live_weather_cache (
            id                INT AUTO_INCREMENT PRIMARY KEY,
            city_name         VARCHAR(100) NOT NULL,
            fetched_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at        DATETIME,
            temperature_c     FLOAT,
            feels_like_c      FLOAT,
            humidity_pct      FLOAT,
            pressure_hpa      FLOAT,
            wind_speed_kmh    FLOAT,
            cloud_cover_pct   FLOAT,
            weather_condition VARCHAR(100),
            weather_desc      VARCHAR(200),
            rain_1h_mm        FLOAT DEFAULT 0,
            UNIQUE KEY unique_city (city_name)
        )
    """)
    print("    created  live_weather_cache")

    conn.commit()
    cursor.close()
    conn.close()


def load_weather_data():
    print(f"\n  Loading last {MONTHS_TO_LOAD} months into MySQL...")

    # ── Check if already loaded ──
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM weather_data")
    existing = cursor.fetchone()[0]
    cursor.close()
    conn.close()

    if existing > 0:
        print(f"  weather_data already has {existing:,} rows — skipping.")
        print(f"  Run TRUNCATE TABLE weather_data in MySQL Workbench to reload.")
        return

    # ── Read CSV ──
    print("  Reading CSV file...")
    df = pd.read_csv(DATASET_PATH, low_memory=False)
    print(f"  Total rows   : {len(df):,}")

    # ── strip +05:30 timezone ──
    print("  Parsing datetime column...")
    df["datetime"] = pd.to_datetime(df["datetime"])
    if df["datetime"].dt.tz is not None:
        df["datetime"] = df["datetime"].dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    print(f"  Date range   : {df['datetime'].min()} → {df['datetime'].max()}")

    # ── Filter last 12 months ──
    cutoff = pd.Timestamp.now() - pd.DateOffset(months=MONTHS_TO_LOAD)
    print(f"  Cutoff date  : {cutoff.strftime('%Y-%m-%d')}")
    df_load = df[df["datetime"] >= cutoff].copy()
    print(f"  Filtered rows: {len(df_load):,}")

    if len(df_load) == 0:
        print("  WARNING: 0 rows after filter — using last 500,000 rows instead")
        df_load = df.tail(500000).copy()

    print(f"  Cities       : {df_load['city'].nunique()}")

    # ── Keep only MySQL table columns ──
    table_cols = [
        "datetime", "city", "climate_zone", "latitude", "longitude",
        "temperature_c", "humidity_pct", "precipitation_mm", "wind_speed_kmh",
        "wind_direction_deg", "pressure_hpa", "cloud_cover_pct", "feels_like_c",
        "weather_code", "rain_flag", "season", "month", "hour", "year"
    ]
    available    = [c for c in table_cols if c in df_load.columns]
    df_load      = df_load[available].copy()
    df_load      = df_load.where(pd.notnull(df_load), None)

    # Convert weather_code to int
    if "weather_code" in df_load.columns:
        df_load["weather_code"] = pd.to_numeric(
            df_load["weather_code"], errors="coerce"
        ).fillna(0).astype(int)

    # ── Insert in chunks ──
    print(f"\n  Inserting {len(df_load):,} rows in chunks of {CHUNK_SIZE:,}...")
    conn         = get_connection()
    cursor       = conn.cursor()
    total        = len(df_load)
    inserted     = 0
    cols_str     = ", ".join(available)
    placeholders = ", ".join(["%s"] * len(available))
    sql          = f"INSERT INTO weather_data ({cols_str}) VALUES ({placeholders})"

    for start in range(0, total, CHUNK_SIZE):
        while True:  # retry loop
            try:
                chunk = df_load.iloc[start:start + CHUNK_SIZE]
                rows = list(chunk.itertuples(index=False, name=None))

                cursor.executemany(sql, rows)
                conn.commit()

                inserted += len(rows)

                pct = int(inserted / total * 30)
                bar = "█" * pct + "░" * (30 - pct)
                print(f"\r    [{bar}] {inserted:>7,} / {total:,}", end="", flush=True)

                break  # ✅ success → exit retry loop

            except Exception as e:
                print(f"\n⚠️ Error: {e}")
                print("🔄 Reconnecting and retrying this chunk...")

                try:
                    conn.close()
                except:
                    pass

                conn = get_connection()
                cursor = conn.cursor()


def verify():
    print("\n  Verifying database contents...")
    conn   = get_connection()
    cursor = conn.cursor()

    tables = ["weather_data", "predictions", "search_history", "live_weather_cache"]
    print(f"\n  {'Table':<25} {'Rows':>10}")
    print(f"  {'─' * 36}")
    for table in tables:
        cursor.execute(f"SELECT COUNT(*) FROM {table}")
        count = cursor.fetchone()[0]
        print(f"  {table:<25} {count:>10,}")

    cursor.execute("""
        SELECT city, COUNT(*) as cnt
        FROM weather_data
        GROUP BY city
        ORDER BY city ASC
    """)
    rows = cursor.fetchall()
    if rows:
        print(f"\n  Rows per city:")
        for city, cnt in rows:
            print(f"    {city:<25}: {cnt:>7,}")

    cursor.close()
    conn.close()


def main():
    print("=" * 60)
    print("  STEP 3 — Loading Dataset into MySQL")
    print("=" * 60 + "\n")

    create_database()
    create_tables()
    load_weather_data()
    verify()

    print("\n" + "=" * 60)
    print("  MySQL setup complete!")
    print(f"  Database : {DB_NAME}")
    print(f"  Tables   : weather_data, predictions,")
    print(f"             search_history, live_weather_cache")
    print("\n  Open MySQL Workbench → run this to verify:")
    print("  SELECT city, COUNT(*) FROM weather_data GROUP BY city;")
    print("\n  Data loaded successfully")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
