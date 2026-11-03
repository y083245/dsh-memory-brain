#!/usr/bin/env python3
# APIHUB_PATCH：start-all.sh / stop-all.sh 共用的小工具（约定 docs/design/worker-kit/apihub/contract.md §6）。
#
# 为什么用 python 而不是 jq / node：远程机和开源教程里都有 python3；写 config.json 要
# 「读整份 → 只改 memoryRag.enabled → 临时文件 + os.replace」，用标准库三行就写完，还能保住原权限。
#
# 用法：
#   python3 scripts/rag-config.py get-enabled <repo>          # 打印 true / false；读失败也打印 false，退出码 0
#   python3 scripts/rag-config.py set-enabled <repo> true|false
#   python3 scripts/rag-config.py embedding-managed <repo>    # 打印 yes / no
#
# 约定：
# - <repo> 是仓库根（config.json、state/、sidecars/ 都在它下面）。
# - get-enabled 的「读」：没有 memoryRag、没有 enabled、不是 true 都算 false（与桥接一致）。
# - set-enabled 只改这一项，其它键原样、权限原样；config.json 不存在或不是合法 JSON → 不写、退出 1。
# - embedding-managed：设置文件（state/long-memory/rag/embedding-settings.json）的 kind
#   为 bundled = 本脚本管（yes），local / cloud = 用户自己的，不管（no）；
#   没有设置文件时按 sidecars/memory-rag/config.yml 的 embedding.provider
#   （local 或缺 = 管，api = 不管）。设置文件读不懂 / kind 不认识时也按 config.yml 回落，并在 stderr 说明。
#   UPGRADE_PATCH：config.yml 先合并用户覆盖 <state>/long-memory/rag/config.local.yml 再看 provider
#   （合并规则同 memory_rag/config.py 的 merge_config；覆盖坏了在 stderr 说明、按没有覆盖算）。
# - 错误一律写 stderr；stdout 只放给 shell 读的那一个词。

import copy
import json
import os
import stat
import sys
import tempfile

CONFIG_NAME = 'config.json'
SETTINGS_REL = ('state', 'long-memory', 'rag', 'embedding-settings.json')
RAG_YML_REL = ('sidecars', 'memory-rag', 'config.yml')
# UPGRADE_PATCH：用户覆盖，相对 state 目录（state 按出厂 config.yml 的 state_dir / MEMORY_RAG_STATE_DIR 解析）
RAG_LOCAL_REL = ('long-memory', 'rag', 'config.local.yml')

RAG_KINDS = ('bundled', 'local', 'cloud')


def _note(message):
    print('rag-config: %s' % message, file=sys.stderr)


def _config_path(repo):
    return os.path.join(repo, CONFIG_NAME)


def _read_json(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def _enabled_of(document):
    """memoryRag.enabled 只有**正好是 true** 才算开；缺省、非布尔、memoryRag 不是对象都算关。"""
    if not isinstance(document, dict):
        return False
    rag = document.get('memoryRag')
    if not isinstance(rag, dict):
        return False
    return rag.get('enabled') is True


def cmd_get_enabled(repo):
    path = _config_path(repo)
    try:
        document = _read_json(path)
    except Exception as error:  # 读失败不拦住启动：按关处理，让脚本继续往下走
        _note('读不了 %s（%s），按 false 处理' % (path, type(error).__name__))
        print('false')
        return 0
    print('true' if _enabled_of(document) else 'false')
    return 0


def _atomic_write_json(path, document, mode):
    """同目录临时文件 + os.replace：别的进程要么看到旧内容、要么看到新内容，不会读到半截。"""
    directory = os.path.dirname(path) or '.'
    fd, temp = tempfile.mkstemp(prefix='.config.json.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.chmod(temp, mode)
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def cmd_set_enabled(repo, value):
    path = _config_path(repo)
    wanted = value == 'true'
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            text = handle.read()
    except FileNotFoundError:
        _note('%s 不存在，不创建（RAG 开关由桥接 / 控制台写）' % path)
        return 1
    except OSError as error:
        _note('读不了 %s（%s），没改' % (path, type(error).__name__))
        return 1
    try:
        document = json.loads(text)
    except ValueError:
        _note('%s 不是合法 JSON，没改' % path)
        return 1
    if not isinstance(document, dict):
        _note('%s 的顶层不是对象，没改' % path)
        return 1
    rag = document.get('memoryRag')
    if rag is None:
        rag = {}
        document['memoryRag'] = rag
    elif not isinstance(rag, dict):
        _note('%s 的 memoryRag 不是对象，没改' % path)
        return 1
    rag['enabled'] = wanted
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError as error:
        _note('读不了 %s 的权限（%s），没改' % (path, type(error).__name__))
        return 1
    try:
        _atomic_write_json(path, document, mode)
    except OSError as error:
        _note('写不了 %s（%s），没改' % (path, type(error).__name__))
        return 1
    return 0


def _settings_kind(path):
    """设置文件的 kind：返回 (kind 或 None, 说明)。文件不存在时 kind 为 None。"""
    try:
        document = _read_json(path)
    except FileNotFoundError:
        return None, None
    except Exception:
        return None, 'embedding-settings.json 读不了或不是合法 JSON，按 config.yml 判断'
    if not isinstance(document, dict):
        return None, 'embedding-settings.json 的顶层不是对象，按 config.yml 判断'
    kind = document.get('kind')
    if kind in RAG_KINDS:
        return kind, None
    return None, 'embedding-settings.json 的 kind 不认识，按 config.yml 判断'


def _merge(base, local):
    if not (isinstance(base, dict) and isinstance(local, dict)):
        return copy.deepcopy(local)
    out = copy.deepcopy(base)
    for key, value in local.items():
        if value is None:
            out.pop(key, None)
        elif key in out:
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def merge_config(base, local):
    """UPGRADE_PATCH：与 memory_rag/config.py 的 merge_config 逐条一致（复制而不 import：
    本脚本由系统 python3 直接跑，测试还会把它单独复制进假 HOME，旁边没有 memory_rag 包）。
    映射递归合并；列表与标量整体替换；null = 删键；覆盖顶层不是映射 = 没有覆盖；覆盖里的 state_dir 忽略。"""
    if not isinstance(local, dict):
        return copy.deepcopy(base)
    return _merge(base, {key: value for key, value in local.items() if key != 'state_dir'})


def _local_override(yaml, yml_path, document):
    """UPGRADE_PATCH：读用户覆盖；返回 (覆盖或 None, 说明)。不存在 / 读不懂都按没有覆盖。"""
    state = os.environ.get('MEMORY_RAG_STATE_DIR') or document.get('state_dir') or '../../state'
    if not os.path.isabs(str(state)):
        state = os.path.join(os.path.dirname(os.path.abspath(yml_path)), str(state))
    path = os.path.join(str(state), *RAG_LOCAL_REL)
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            local = yaml.safe_load(handle)
    except FileNotFoundError:
        return None, None
    except Exception:
        return None, 'config.local.yml 读不了，按没有覆盖处理'
    if local is not None and not isinstance(local, dict):
        return None, 'config.local.yml 顶层不是映射，按没有覆盖处理'
    return local, None


def _config_yml_provider(repo):
    """按 config.yml（合并用户覆盖后）的 embedding.provider 判断（文件不存在 = local）。"""
    path = os.path.join(repo, *RAG_YML_REL)
    if not os.path.exists(path):
        return 'local', None
    try:
        import yaml  # 远程机可能没装；没装就按 local（与旧行为一致）
    except ImportError:
        return 'local', '没装 PyYAML，按 local 处理'
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            document = yaml.safe_load(handle) or {}
    except Exception:
        return 'local', 'config.yml 读不了，按 local 处理'
    if not isinstance(document, dict):
        return 'local', 'config.yml 顶层不是对象，按 local 处理'
    local, note = _local_override(yaml, path, document)
    if local:
        document = merge_config(document, local)
    embedding = document.get('embedding')
    provider = embedding.get('provider') if isinstance(embedding, dict) else None
    if provider == 'api':
        return 'api', note
    return 'local', note


def cmd_embedding_managed(repo):
    kind, note = _settings_kind(os.path.join(repo, *SETTINGS_REL))
    if note:
        _note(note)
    if kind is not None:
        print('yes' if kind == 'bundled' else 'no')
        return 0
    provider, note = _config_yml_provider(repo)
    if note:
        _note(note)
    print('no' if provider == 'api' else 'yes')
    return 0


def main(argv):
    if len(argv) < 3:
        print('用法：%s get-enabled <repo> | set-enabled <repo> true|false | embedding-managed <repo>' % argv[0],
              file=sys.stderr)
        return 2
    command, repo = argv[1], argv[2]
    if command == 'get-enabled':
        return cmd_get_enabled(repo)
    if command == 'set-enabled':
        if len(argv) < 4 or argv[3] not in ('true', 'false'):
            print('用法：%s set-enabled <repo> true|false' % argv[0], file=sys.stderr)
            return 2
        return cmd_set_enabled(repo, argv[3])
    if command == 'embedding-managed':
        return cmd_embedding_managed(repo)
    print('不认识的动作：%s' % command, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
