import json
import os
import shutil
import re

NEW_KEY = 'YYstRBLoxUZ1JLeo9Rd+yw=='
BASE_URL = 'https://api-sf1.deploy.com/api/v1'

# 1. Update all auth.json files
auth_paths = [
    r'C:\Users\yago\.local\share\opencode\auth.json',
    r'C:\Users\yago\.t3\userdata\providers\opencode-deepseek\data\opencode\auth.json',
    r'C:\Users\yago\.t3\tools\opencode\1.15.13\data\opencode\auth.json',
]

for ap in auth_paths:
    if os.path.exists(ap):
        shutil.copy2(ap, ap + '.bak_new')
        with open(ap, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data['deepseek'] = {'key': NEW_KEY, 'type': 'api'}
        data['deploy'] = {'key': NEW_KEY, 'type': 'api'}
        data['deepseek_api_key'] = {'key': NEW_KEY, 'type': 'api'}
        with open(ap, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        print('Updated auth:', ap)

# 2. Deploy provider config definition
deploy_provider = {
    'name': 'Deploy',
    'npm': '@ai-sdk/openai-compatible',
    'options': {
        'baseURL': BASE_URL,
        'apiKey': NEW_KEY
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

deepseek_provider = {
    'name': 'DeepSeek (Deploy)',
    'npm': '@ai-sdk/openai-compatible',
    'options': {
        'baseURL': BASE_URL,
        'apiKey': NEW_KEY
    },
    'models': {
        'deepseek-ai/deepseek-v4.1-flash-1017': {
            'name': 'DeepSeek V4.1 Flash',
            'limit': {
                'context': 1000000,
                'output': 384000
            }
        },
        'deepseek-flash': {
            'name': 'DeepSeek V4.1 Flash 1017',
            'limit': {
                'context': 1000000,
                'output': 384000
            }
        }
    }
}

config_paths = [
    r'C:\Users\yago\.config\opencode\opencode.json',
    r'C:\Users\yago\.t3\userdata\providers\opencode-deepseek\config\opencode\opencode.jsonc',
    r'C:\Users\yago\.t3\tools\opencode\1.15.13\config\opencode\opencode.json'
]

for cp in config_paths:
    if os.path.exists(cp):
        shutil.copy2(cp, cp + '.bak_new')
        with open(cp, 'r', encoding='utf-8-sig') as f:
            raw = f.read()
        try:
            cfg = json.loads(raw)
        except Exception:
            clean = re.sub(r'//.*', '', raw)
            cfg = json.loads(clean)
        
        if 'provider' not in cfg:
            cfg['provider'] = {}
        cfg['provider']['deploy'] = deploy_provider
        cfg['provider']['deepseek'] = deepseek_provider
        
        with open(cp, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2)
        print('Updated config:', cp)

# 3. Update deepseek-t3.cmd
cmd_path = r'C:\Users\yago\.t3\tools\opencode\deepseek-t3.cmd'
if os.path.exists(cmd_path):
    with open(cmd_path, 'r', encoding='utf-8') as f:
        cmd_content = f.read()
    cmd_content = re.sub(r'set \"DEEPSEEK_API_KEY=.*\"', f'set "DEEPSEEK_API_KEY={NEW_KEY}"', cmd_content)
    cmd_content = re.sub(r'set \"DEPLOY_API_KEY=.*\"', f'set "DEPLOY_API_KEY={NEW_KEY}"', cmd_content)
    with open(cmd_path, 'w', encoding='utf-8') as f:
        f.write(cmd_content)
    print('Updated cmd:', cmd_path)

# 4. Update .env
env_path = r'C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\.env'
if os.path.exists(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    new_lines = []
    has_deploy = False
    for line in lines:
        if line.startswith('DEPLOY_API_KEY='):
            new_lines.append(f'DEPLOY_API_KEY={NEW_KEY}\n')
            has_deploy = True
        elif line.startswith('DEEPSEEK_API_KEY='):
            new_lines.append(f'DEEPSEEK_API_KEY={NEW_KEY}\n')
        elif line.startswith('DEPLOY_BASE_URL='):
            new_lines.append(f'DEPLOY_BASE_URL={BASE_URL}\n')
        else:
            new_lines.append(line)
    if not has_deploy:
        new_lines.append(f'DEPLOY_API_KEY={NEW_KEY}\n')
        new_lines.append(f'DEPLOY_BASE_URL={BASE_URL}\n')
    with open(env_path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    print('Updated .env')
