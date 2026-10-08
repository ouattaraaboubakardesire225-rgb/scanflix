from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os

app = FastAPI(title="Scanflix")

# Dictionnaire de correspondance des mots-clés vers les plateformes de streaming direct
STREAMING_TARGETS = {
    "netflix": "https://www.netflix.com",
    "prime": "https://www.primevideo.com",
    "canal": "https://www.canalplus.com",
    "youtube": "https://www.youtube.com"
}

class ScanRequest(BaseModel):
    code: str

@app.post("/api/v1/scan")
def scan_code(req: ScanRequest):
    val = req.code.strip().lower()
    
    # Vérifie si l'entrée est un mot-clé direct
    if val in STREAMING_TARGETS:
        return {"redirect_url": STREAMING_TARGETS[val]}
    
    # Vérifie si l'entrée est une URL valide
    if val.startswith("http://") or val.startswith("https://"):
        return {"redirect_url": val}
    
    # Si le mot-clé contient une des plateformes
    for key, url in STREAMING_TARGETS.items():
        if key in val:
            return {"redirect_url": url}
            
    raise HTTPException(status_code=400, detail="Code ou lien inconnu. Essayez netflix, prime, canal, youtube ou une URL.")

# Sert les fichiers statiques de l'interface (index.html, images, etc.)
if os.path.exists("index.html"):
    @app.get("/")
    def read_index():
        return FileResponse("index.html")

app.mount("/", StaticFiles(directory="."), name="static")

