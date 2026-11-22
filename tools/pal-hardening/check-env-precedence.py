"""Vérifie, avec un .env FICTIF temporaire, que la variable d'environnement du PROCESSUS l'emporte sur le .env (python-dotenv, override=False
par défaut dans PAL) : c'est le mécanisme qui permettrait de neutraliser la clé OpenAI de PAL sans la supprimer. N'ouvre aucun .env réel."""
import os, sys, tempfile, json
from dotenv import load_dotenv, dotenv_values

PLACEHOLDER = "your_openai_api_key_here"  # valeur reconnue comme « absente » par PAL (server.py, configure_providers)
with tempfile.TemporaryDirectory() as d:
    env_file = os.path.join(d, ".env")
    with open(env_file, "w", encoding="utf-8") as f:
        f.write("OPENAI_API_KEY=FAUX-CLE-DE-TEST\nAZURE_OPENAI_API_KEY=FAUX-AZURE\nGEMINI_API_KEY=FAUX-GEMINI\n")
    os.environ["OPENAI_API_KEY"] = PLACEHOLDER      # posé par le « env » du serveur MCP (hypothèse à valider dans Claude Code)
    os.environ["AZURE_OPENAI_API_KEY"] = PLACEHOLDER
    os.environ.pop("GEMINI_API_KEY", None)
    load_dotenv(dotenv_path=env_file, override=False)  # comportement par défaut de PAL
    res = {
        "openai_neutralisee_par_l_env_du_processus": os.environ["OPENAI_API_KEY"] == PLACEHOLDER,
        "azure_neutralisee": os.environ["AZURE_OPENAI_API_KEY"] == PLACEHOLDER,
        "gemini_toujours_lue_depuis_dotenv": os.environ.get("GEMINI_API_KEY") == "FAUX-GEMINI",
        "avec_override_true_le_dotenv_gagnerait": (lambda: (load_dotenv(dotenv_path=env_file, override=True), os.environ["OPENAI_API_KEY"] == "FAUX-CLE-DE-TEST")[1])(),
    }
    print(json.dumps(res))
