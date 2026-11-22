"""Sonde chargeur seulement : aucun import de serveur, dotenv, agent ou provider."""
import json
import sys
import types
from pathlib import Path
pal, config = map(Path, sys.argv[1:])
sys.dont_write_bytecode = True
sys.path.insert(0, str(pal))
# Ne pas importer utils.env : son import lit et applique le .env actif.
utils = types.ModuleType('utils')
utils.__path__ = []
sys.modules['utils'] = utils
env = types.ModuleType('utils.env')
env.get_env = lambda name, default=None: default
sys.modules['utils.env'] = env
file_utils = types.ModuleType('utils.file_utils')
file_utils.read_json_file = lambda name: json.loads(Path(name).read_text(encoding='utf-8-sig'))
sys.modules['utils.file_utils'] = file_utils
from clink.registry import ClinkRegistry, RegistryLoadError
from clink.models import CLIClientConfig
# Ne pas initialiser le registre : il chargerait les configurations actives.
registry = object.__new__(ClinkRegistry)
raw = json.loads(config.read_text(encoding='utf-8-sig'))
resolved = registry._resolve_config(CLIClientConfig.model_validate(raw), source_path=config)
assert resolved.executable[-1].endswith('pal-analysis-gate.mjs')
assert all(role.prompt_path.exists() and not role.role_args for role in resolved.roles.values())
args = resolved.internal_args + resolved.config_args
assert args[0] == 'exec'
dangerous = any('--dangerously-' in arg or '--yolo' in arg for arg in args)
assert not dangerous
# CodexAgent tente une récupération après erreur : stderr seul ne doit pas devenir un succès.
from clink.parsers.codex import CodexJSONLParser
from clink.parsers.base import ParserError
try:
    CodexJSONLParser().parse('', '{"status":"blocked","spawned":false}')
except ParserError:
    pass
else:
    raise AssertionError('Refus gate récupéré comme succès')
raw['name'] = 'codex-inconnu'
try:
    registry._resolve_config(CLIClientConfig.model_validate(raw), source_path=config)
except RegistryLoadError:
    rejected = True
else:
    rejected = False
assert rejected
print(json.dumps({'accepted': True, 'unknownRejected': rejected, 'dangerousDefaults': dangerous}))
