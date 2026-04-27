"""
ForecastIQ — Intelligent Weather Prediction using Machine Learning
Flask Backend - app.py
Run: python app.py
"""

from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
import joblib
import pandas as pd
import numpy as np
import requests
import os
import time
import base64
from datetime import datetime, timedelta

load_dotenv()

app = Flask(__name__)
CORS(app)

# ── CONFIG ──────────────────────────────────────
API_KEY              = os.getenv("OPENWEATHER_API_KEY")
FRESHSERVICE_API_KEY = os.getenv("FRESHSERVICE_API_KEY")
FRESHSERVICE_DOMAIN  = os.getenv("FRESHSERVICE_DOMAIN")


# ── Load ML Models ───────────────────────────────
print("Loading ML models...")
temp_model     = joblib.load("models/temp_model.pkl")
humidity_model = joblib.load("models/humidity_model.pkl")
rain_model     = joblib.load("models/rain_model.pkl")
feature_cols   = pd.read_csv("data/processed/feature_columns.csv").squeeze().tolist()
city_encoder   = pd.read_csv("data/processed/city_encoder.csv")
city_map       = dict(zip(city_encoder["city"].str.lower(), city_encoder["code"]))
print(f"Models loaded! Features: {len(feature_cols)}")


# ─────────────────────────────────────────────────
# DATABASE FUNCTIONS
# ─────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(os.getenv("DATABASE_URL"))

def save_search_history(city_name, was_found, response_ms=0):
    try:
        conn   = get_db()
        cursor = conn.cursor()
        
        cursor.execute(
            "INSERT INTO search_history (city_name, was_found, response_ms) VALUES (%s, %s, %s)",
            (city_name, bool(was_found), int(response_ms))
        )
        conn.commit()
        cursor.close()
        conn.close()
        print(f"  [DB] search_history saved: {city_name}")
    except Exception as e:
        print(f"  [DB ERROR] search_history: {e}")


def save_prediction(city_name, pred):
    try:
        conn   = get_db()
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO predictions
               (city_name, predicted_temp, predicted_humidity,
               predicted_rain, rain_probability, model_used)
            VALUES (%s,%s,%s,%s,%s,%s)
        """, (
            city_name,
            float(pred["predicted_temp"]),
            float(pred["predicted_humidity"]),
            bool(pred["predicted_rain"]),
            float(pred["rain_probability"]),
            "XGBoost+RandomForest"
        ))
        conn.commit()
        cursor.close()
        conn.close()
        print(f"  [DB] prediction saved: {city_name}")
    except Exception as e:
        print(f"  [DB ERROR] predictions: {e}")


def save_live_cache(weather):
    try:
        conn    = get_db()
        cursor  = conn.cursor()
        expires = (datetime.now() + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute("""
            INSERT INTO live_weather_cache
                (city_name, temperature_c, feels_like_c, humidity_pct,
                 pressure_hpa, wind_speed_kmh, cloud_cover_pct,
                 weather_condition, weather_desc, rain_1h_mm, expires_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (city_name) DO UPDATE SET
                temperature_c = EXCLUDED.temperature_c,
                feels_like_c = EXCLUDED.feels_like_c,
                humidity_pct = EXCLUDED.humidity_pct,
                pressure_hpa = EXCLUDED.pressure_hpa,
                wind_speed_kmh = EXCLUDED.wind_speed_kmh,
                cloud_cover_pct = EXCLUDED.cloud_cover_pct,
                weather_condition = EXCLUDED.weather_condition,
                weather_desc = EXCLUDED.weather_desc,
                rain_1h_mm = EXCLUDED.rain_1h_mm,
                fetched_at = NOW(),
                expires_at = EXCLUDED.expires_at
        """, (
            weather["city_name"], weather["temperature_c"],
            weather["feels_like_c"], weather["humidity_pct"],
            weather["pressure_hpa"], weather["wind_speed_kmh"],
            weather["cloud_cover_pct"], weather["weather_condition"],
            weather["weather_desc"], weather["rain_1h_mm"], expires
        ))
        conn.commit()
        cursor.close()
        conn.close()
        print(f"  [DB] live_weather_cache saved: {weather['city_name']}")
    except Exception as e:
        print(f"  [DB ERROR] live_weather_cache: {e}")


def get_cached_weather(city_name):
    try:
        conn   = get_db()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute(
            "SELECT * FROM live_weather_cache WHERE city_name=%s AND expires_at > NOW()",
            (city_name,)
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row
 
    except Exception as e:
        print(f"[DB ERROR] cache fetch: {e}")
        return None


def save_ticket_to_db(name, email, issue_type, city, description, ticket_id):
    """Save ticket to PostgreSQL (Supabase) as backup."""
    try:
        conn   = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tickets (
                id              SERIAL PRIMARY KEY,
                freshservice_id INT,
                name            VARCHAR(100),
                email           VARCHAR(150),
                issue_type      VARCHAR(100),
                city            VARCHAR(100),
                description     TEXT,
                status          VARCHAR(50) DEFAULT 'Open',
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            INSERT INTO tickets
                (freshservice_id, name, email, issue_type, city, description)
            VALUES (%s,%s,%s,%s,%s,%s)
        """, (ticket_id, name, email, issue_type, city, description))
        conn.commit()
        cursor.close()
        conn.close()
        print(f"  [DB] ticket saved: #{ticket_id}")
    except Exception as e:
        print(f"  [DB ERROR] tickets: {e}")


# ─────────────────────────────────────────────────
# FRESHSERVICE TICKETING
# ─────────────────────────────────────────────────

def create_freshservice_ticket(name, email, issue_type, city, description):
    """
    Creates a ticket in Freshservice using their REST API.
    Auth: Basic Auth with API_KEY:X (base64 encoded)
    """
    if not FRESHSERVICE_API_KEY or not FRESHSERVICE_DOMAIN:
        print("  [TICKET ERROR] Freshservice credentials missing in .env")
        return None

    # Full HTML description for the ticket
    full_description = f"""
        <b>Issue reported from ForecastIQ</b><br><br>
        <b>Name:</b> {name}<br>
        <b>Email:</b> {email}<br>
        <b>Issue Type:</b> {issue_type}<br>
        <b>City:</b> {city if city else 'Not specified'}<br>
        <b>Reported At:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}<br><br>
        <b>Description:</b><br>{description}
    """

    # Priority mapping
    priority_map = {
        "App Bug":          2,
        "Wrong Prediction": 2,
        "City Not Found":   1,
        "Feature Request":  1,
        "Other":            1,
    }

    payload = {
        "subject":     f"[ForecastIQ] {issue_type} — {city if city else 'General'}",
        "description": full_description,
        "email":       email,
        "priority":    priority_map.get(issue_type, 1),
        "status":      2,   # Open
        "source":      2,   # Portal
        "tags":        ["forecastiq", issue_type.lower().replace(" ", "-")],
    }

    # Freshservice uses API_KEY:X as Basic Auth
    credentials = base64.b64encode(
        f"{FRESHSERVICE_API_KEY}:X".encode()
    ).decode()

    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Basic {credentials}",
    }

    url = f"https://{FRESHSERVICE_DOMAIN}/api/v2/tickets"

    try:
        print(f"  [TICKET] Sending to Freshservice: {url}")
        resp = requests.post(url, json=payload, headers=headers, timeout=15)

        if resp.status_code == 201:
            ticket = resp.json().get("ticket", {})
            print(f"  [TICKET] Success! ID: #{ticket.get('id')}")
            return {
                "id":      ticket.get("id"),
                "subject": ticket.get("subject"),
                "status":  "Created",
            }
        else:
            print(f"  [TICKET ERROR] {resp.status_code}: {resp.text}")
            return None

    except requests.exceptions.ConnectionError:
        print("  [TICKET ERROR] Cannot reach Freshservice. Check domain.")
        return None
    except Exception as e:
        print(f"  [TICKET ERROR] {e}")
        return None


# ─────────────────────────────────────────────────
# WEATHER & ML HELPERS
# ─────────────────────────────────────────────────

def fetch_live_weather(city_name):
    url    = "https://api.openweathermap.org/data/2.5/weather"
    params = {"q": city_name + ",IN", "appid": API_KEY, "units": "metric"}
    resp   = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        params["q"] = city_name
        resp = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        return None
    d = resp.json()
    return {
        "city_name":         d["name"],
        "temperature_c":     round(d["main"]["temp"], 1),
        "feels_like_c":      round(d["main"]["feels_like"], 1),
        "humidity_pct":      d["main"]["humidity"],
        "pressure_hpa":      d["main"]["pressure"],
        "wind_speed_kmh":    round(d["wind"]["speed"] * 3.6, 1),
        "cloud_cover_pct":   d["clouds"]["all"],
        "weather_condition": d["weather"][0]["main"],
        "weather_desc":      d["weather"][0]["description"].title(),
        "rain_1h_mm":        d.get("rain", {}).get("1h", 0.0),
    }


def make_prediction(weather):
    now  = datetime.now()
    feat = {col: 0.0 for col in feature_cols}
    feat["wind_speed_kmh"]     = weather.get("wind_speed_kmh", 0)
    feat["wind_direction_deg"] = 0
    feat["pressure_hpa"]       = weather.get("pressure_hpa", 1013)
    feat["cloud_cover_pct"]    = weather.get("cloud_cover_pct", 0)
    feat["hour"]               = now.hour
    feat["month"]              = now.month
    feat["year"]               = now.year
    feat["hour_sin"]           = np.sin(2 * np.pi * now.hour  / 24)
    feat["hour_cos"]           = np.cos(2 * np.pi * now.hour  / 24)
    feat["month_sin"]          = np.sin(2 * np.pi * now.month / 12)
    feat["month_cos"]          = np.cos(2 * np.pi * now.month / 12)
    feat["city_encoded"]       = city_map.get(weather.get("city_name","").lower(), 0)
    m = now.month
    feat["season_encoded"] = 3 if m in [12,1,2] else 2 if m in [3,4,5] else 1 if m in [6,7,8,9] else 0
    ct = weather.get("temperature_c", 25)
    ch = weather.get("humidity_pct",  60)
    cr = weather.get("rain_1h_mm",     0)
    for lag in [1,3,6,12,24]:
        feat[f"temperature_c_lag_{lag}"]    = ct
        feat[f"humidity_pct_lag_{lag}"]     = ch
        feat[f"precipitation_mm_lag_{lag}"] = cr
    feat["temperature_c_roll_24h"] = ct
    feat["temperature_c_roll_7d"]  = ct
    feat["humidity_pct_roll_24h"]  = ch
    feat["humidity_pct_roll_7d"]   = ch
    X  = pd.DataFrame([feat])[feature_cols]
    pt = round(float(temp_model.predict(X)[0]), 1)
    ph = round(float(humidity_model.predict(X)[0]), 1)
    pr = int(rain_model.predict(X)[0])
    pp = round(float(rain_model.predict_proba(X)[0][1]) * 100, 1)
    return {
        "predicted_temp":     max(-20, min(55, pt)),
        "predicted_humidity": max(0,   min(100, ph)),
        "predicted_rain":     pr,
        "rain_probability":   pp,
    }


# ─────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/weather", methods=["GET"])
def get_weather():
    city = request.args.get("city", "").strip()
    if not city:
        return jsonify({"error": "City name is required"}), 400
    start_ms   = int(time.time() * 1000)
    cached     = get_cached_weather(city)
    from_cache = False
    if cached:
        weather = {k: cached[k] for k in [
            "city_name","temperature_c","feels_like_c","humidity_pct",
            "pressure_hpa","wind_speed_kmh","cloud_cover_pct",
            "weather_condition","weather_desc"
        ]}
        weather["rain_1h_mm"] = cached.get("rain_1h_mm", 0)
        from_cache = True
    else:
        weather = fetch_live_weather(city)
    if not weather:
        save_search_history(city, was_found=False)
        return jsonify({"error": f"City '{city}' not found. Please check spelling."}), 404
    if not from_cache:
        save_live_cache(weather)
    prediction  = make_prediction(weather)
    response_ms = int(time.time() * 1000) - start_ms
    save_search_history(weather["city_name"], was_found=True, response_ms=response_ms)
    save_prediction(weather["city_name"], prediction)
    return jsonify({
        "city": weather["city_name"],
        "current": {
            "temperature":  weather["temperature_c"],
            "feels_like":   weather["feels_like_c"],
            "humidity":     weather["humidity_pct"],
            "pressure":     weather["pressure_hpa"],
            "wind_speed":   weather["wind_speed_kmh"],
            "cloud_cover":  weather["cloud_cover_pct"],
            "condition":    weather["weather_condition"],
            "description":  weather["weather_desc"],
            "rain_mm":      weather["rain_1h_mm"],
        },
        "prediction": {
            "temperature":      prediction["predicted_temp"],
            "humidity":         prediction["predicted_humidity"],
            "will_rain":        bool(prediction["predicted_rain"]),
            "rain_probability": prediction["rain_probability"],
        },
        "from_cache":  from_cache,
        "response_ms": response_ms,
    })


@app.route("/api/forecast", methods=["GET"])
def get_forecast():
    city = request.args.get("city", "").strip()
    if not city:
        return jsonify({"error": "City name is required"}), 400
    url    = "https://api.openweathermap.org/data/2.5/forecast"
    params = {"q": city + ",IN", "appid": API_KEY, "units": "metric", "cnt": 40}
    resp   = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        params["q"] = city
        resp = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        return jsonify({"error": f"Forecast not available for '{city}'"}), 404
    data = resp.json()
    return jsonify({
        "city": data["city"]["name"],
        "forecast": [{
            "datetime":    i["dt_txt"],
            "temperature": i["main"]["temp"],
            "humidity":    i["main"]["humidity"],
            "condition":   i["weather"][0]["main"],
            "description": i["weather"][0]["description"].title(),
            "wind_speed":  round(i["wind"]["speed"] * 3.6, 1),
            "rain_mm":     i.get("rain", {}).get("3h", 0),
            "rain_prob":   round(i.get("pop", 0) * 100, 1),
        } for i in data["list"]]
    })


@app.route("/api/history", methods=["GET"])
def get_history():
    limit = int(request.args.get("limit", 8))
    try:
        conn   = get_db()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("""
            SELECT city_name, searched_at, was_found, response_ms
            FROM search_history ORDER BY searched_at DESC LIMIT %s
        """, (limit,))
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        for r in rows:
            r["searched_at"] = str(r["searched_at"])
        return jsonify({"history": rows})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stats", methods=["GET"])
def get_stats():
    try:
        conn   = get_db()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("SELECT COUNT(*) as total FROM search_history")
        total_searches = cursor.fetchone()["total"]
        cursor.execute("SELECT COUNT(*) as total FROM predictions")
        total_predictions = cursor.fetchone()["total"]
        cursor.execute("""
            SELECT city_name, COUNT(*) as count FROM search_history
            WHERE was_found = TRUE GROUP BY city_name ORDER BY count DESC LIMIT 5
        """)
        top_cities = cursor.fetchall()
        cursor.execute("SELECT COUNT(*) as total FROM weather_data")
        dataset_rows = cursor.fetchone()["total"]
        cursor.close()
        conn.close()
        return jsonify({
            "total_searches":    total_searches,
            "total_predictions": total_predictions,
            "top_cities":        top_cities,
            "dataset_rows":      dataset_rows,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ticket", methods=["POST"])
def create_ticket():
    """
    POST /api/ticket
    Body: { name, email, issue_type, city, description }
    Creates ticket in Freshservice + saves to MySQL
    """
    data = request.get_json()

    # Validate
    for field in ["name", "email", "issue_type", "description"]:
        if not data.get(field, "").strip():
            return jsonify({"success": False, "error": f"'{field}' is required"}), 400

    name        = data["name"].strip()
    email       = data["email"].strip()
    issue_type  = data["issue_type"].strip()
    city        = data.get("city", "").strip()
    description = data["description"].strip()

    if "@" not in email or "." not in email:
        return jsonify({"success": False, "error": "Enter a valid email address"}), 400

    if len(description) < 10:
        return jsonify({"success": False, "error": "Description must be at least 10 characters"}), 400

    # Create in Freshservice
    ticket = create_freshservice_ticket(name, email, issue_type, city, description)

    if ticket:
        save_ticket_to_db(name, email, issue_type, city, description, ticket["id"])
        return jsonify({
            "success":   True,
            "ticket_id": ticket["id"],
            "message":   f"Ticket #{ticket['id']} created! We will contact you at {email}",
        })
    else:
        # Save to MySQL even if Freshservice fails
        save_ticket_to_db(name, email, issue_type, city, description, None)
        return jsonify({
            "success": False,
            "error":   "Freshservice not configured. Check .env file for FRESHSERVICE_API_KEY and FRESHSERVICE_DOMAIN.",
        }), 500


@app.route("/api/tickets", methods=["GET"])
def get_tickets():
    """GET /api/tickets — all tickets from MySQL"""
    try:
        conn   = get_db()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                freshservice_id INT,
                name VARCHAR(100),
                email VARCHAR(150),
                issue_type VARCHAR(100),
                city VARCHAR(100),
                description TEXT,
                status VARCHAR(50) DEFAULT 'Open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
           
        """)
        cursor.execute("""
            SELECT id, freshservice_id, name, email, issue_type,
                   city, status, created_at
            FROM tickets ORDER BY created_at DESC LIMIT 20
        """)
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        for r in rows:
            r["created_at"] = str(r["created_at"])
        return jsonify({"tickets": rows})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("\n" + "="*55)
    print("  ForecastIQ — Intelligent Weather Prediction")
    print("="*55)
    print(f"  Weather API      : {'set' if API_KEY else 'NOT SET'}")
    print(f"  Freshservice API : {'set' if FRESHSERVICE_API_KEY else 'NOT SET'}")
    print(f"  Freshservice URL : {FRESHSERVICE_DOMAIN or 'NOT SET'}")
    print("="*55+"\n")
    # app.run(debug=True, port=5000)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 10000)))
