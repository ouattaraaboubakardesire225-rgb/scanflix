import urllib.parse
import os
from fastapi import FastAPI, File, HTTPException, UploadFile, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

app = FastAPI(title="Scanflix API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def generate_streaming_links(title: str):
    encoded_title = urllib.parse.quote(title)
    return {
        "netflix": f"https://www.netflix.com/search?q={encoded_title}",
        "amazon": f"https://www.primevideo.com/search/ref=atv_sr_sug?phrase={encoded_title}",
        "youtube": f"https://www.youtube.com/results?search_query={encoded_title}+film+complet",
        "moviebox": f"https://www.google.com/search?q={encoded_title}+moviebox"
    }

@app.post("/api/v1/recognize")
async def recognize_scene(file: UploadFile = File(...)):
    allowed_mimeTypes = ["image/jpeg", "image/png", "image/webp"]
    if file.content_type not in allowed_mimeTypes:
        raise HTTPException(status_code=400, detail="Format d'image non supporté (JPG, PNG, WebP).")
    
    contents = await file.read()
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Fichier trop volumineux (max 10 Mo).")

    movie_title = "Le Voyageur"
    return {
        "status": "success",
        "candidate": {
            "title": movie_title,
            "year": 2024,
            "confidence": 0.87,
            "genre": "Sci-Fi / Drame",
            "watch_links": generate_streaming_links(movie_title)
        }
    }

@app.post("/api/v1/webhook/stripe")
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    event_payload = await request.json()
    if event_payload.get("type") == "checkout.session.completed":
        pass
    return {"status": "received"}

@app.get("/")
async def read_index():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"message": "Scanflix API opérationnelle"}
