import json
import os
import shutil

NEW_KEY = 'AOW81YwXQab0HLtiAP4tow=='

# 1. Update auth.json files
auth_paths = [
    r'C:\Users\yago\.t3\userdata\providers\opencode-deepseek\data\opencode\auth.json',
    r'C:\Users\yago\.t3\tools\opencode\1.15.13\data\opencode\auth.json',
    r'C:\Users\yago\.local\share\opencode\auth.json'
]

for ap in auth_paths:
    if os.path.exists(ap):
        shutil.copy2(ap, ap + '.bak_deploy')
        with open(ap, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data['deepseek'] = {'key': NEW_KEY, 'type': 'api'}
        data['deploy'] = {'key': NEW_KEY, 'type': 'api'}
        data['deepseek_api_key'] = {'key': NEW_KEY, 'type': 'api'}
        with open(ap, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        print('Updated auth:', ap)

# 2. Update opencode.jsonc and opencode.json
config_paths = [
    r'C:\Users\yago\.t3\userdata\providers\opencode-deepseek\config\opencode\opencode.jsonc',
    r'C:\Users\yago\.t3\tools\opencode\1.15.13\config\opencode\opencode.json'
]

deploy_provider_def = {
    'name': 'Deploy',
    'npm': '@ai-sdk/openai-compatible',
    'options': {
        'baseURL': 'https://api.deploy.com/api/v1'
    },
    'models': {
        'deepseek-ai/deepseek-v4.1-flash-1017': {
            'name': 'DeepSeek V4.1 Flash (Deploy)',
            'limit': {
                'context': 1000000,
                'output': 384000
            }
        },
        'zai-org/glm-5.3-flash': {
            'name': 'GLM 5.3 Flash (Deploy)',
            'limit': {
                'context': 128000,
                'output': 16384
            }
        }
    }
}

deepseek_provider_def = {
    'name': 'DeepSeek (Deploy)',
    'npm': '@ai-sdk/openai-compatible',
    'options': {
        'baseURL': 'https://api.deploy.com/api/v1'
    },
    'models': {
        'deepseek-ai/deepseek-v4.1-flash-1017': {
            'name': 'DeepSeek V4.1 Flash',
            'limit': {
                'context': 1000000,
                'output': 384000
            }
        }
    }
}

for cp in config_paths:
    if os.path.exists(cp):
        shutil.copy2(cp, cp + '.bak_deploy')
        with open(cp, 'r', encoding='utf-8-sig') as f:
            raw = f.read()
        try:
            cfg = json.loads(raw)
        except Exception:
            import re
            clean = re.sub(r'//.*', '', raw)
            cfg = json.loads(clean)
        
        if 'provider' not in cfg:
            cfg['provider'] = {}
        cfg['provider']['deploy'] = deploy_provider_def
        cfg['provider']['deepseek'] = deepseek_provider_def
        
        with open(cp, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2)
        print('Updated config:', cp)

# 3. Update deepseek-t3.cmd
cmd_path = r'C:\Users\yago\.t3\tools\opencode\deepseek-t3.cmd'
if os.path.exists(cmd_path):
    with open(cmd_path, 'r', encoding='utf-8') as f:
        cmd_content = f.read()
    cmd_content = cmd_content.replace('g3MkUYv38GuSJ3MxZsFBvg==', NEW_KEY)
    if 'DEPLOY_API_KEY' not in cmd_content:
        cmd_content = cmd_content.replace(f'set "DEEPSEEK_API_KEY={NEW_KEY}"', f'set "DEEPSEEK_API_KEY={NEW_KEY}"\nset "DEPLOY_API_KEY={NEW_KEY}"')
    with open(cmd_path, 'w', encoding='utf-8') as f:
        f.write(cmd_content)
    print('Updated cmd:', cmd_path)

# 4. Update .env
env_path = r'C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\.env'
if os.path.exists(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        env_content = f.read()
    env_content = env_content.replace('g3MkUYv38GuSJ3MxZsFBvg==', NEW_KEY)
    if 'DEPLOY_API_KEY' not in env_content:
        env_content += f'\nDEPLOY_API_KEY={NEW_KEY}\n'
    with open(env_path, 'w', encoding='utf-8') as f:
        f.write(env_content)
    print('Updated .env')
