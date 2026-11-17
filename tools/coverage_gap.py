"""Verifica cobertura offline e calcula o intervalo exato que falta."""
import json, io, glob, os

TARGETS = {
    'addrPoint 0x1f899e0': 0x1f899e0,
    'COL reg0   0x204ff70': 0x204ff70,
    'slot vf[-1] 0x1f899d8': 0x1f899d8,
    'DoCall     0x37bc40': 0x37bc40,
    'init str   0x22fe590': 0x22fe590,
}

covered = []
for f in glob.glob('local-data/*.json'):
    try:
        d = json.load(io.open(f, encoding='utf-8'))
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    for r in d.get('reads', []):
        try:
            rva = int(r['rva'], 16)
        except Exception:
            continue
        covered.append((rva, rva + r['read'], os.path.basename(f), r['name']))

print('=== intervalos lidos acumulados ===')
tot = 0
for a, b, f, n in sorted(covered):
    print('  %#010x..%#010x  %3d B  %s / %s' % (a, b, b - a, f, n))
    tot += b - a
print('  total = %d bytes' % tot)
print()

print('=== cada alvo esta coberto? ===')
for name, t in TARGETS.items():
    hit = [c for c in covered if c[0] <= t < c[1]]
    print('  %-24s %s' % (name, ('COBERTO por ' + hit[0][3]) if hit else 'NAO COBERTO'))
print()

print('=== o que falta para "quem instala 0x1f899e0" ===')
print('  Referencias a um endereco ficam em .rdata (vtables estaticas) ou .data')
print('  (membros), como qword absoluto base+RVA.')
print('  Nenhum dos intervalos lidos cobre .rdata fora de 0x204fXXX.')
print()
print('  Varredura necessaria: procurar o qword (base+0x1f899e0) em')
print('    .data     RVA 0x02274000..0x03a1B5F0  (%d bytes)' % 0x17af5f0)
print('    .rdata    RVA 0x01a3d000..0x0226D04C  (%d bytes)' % 0x83604c)
print('  Total: %d bytes' % (0x17af5f0 + 0x83604c))
print()
print('  Alternativa mais barata: o objeto callable e criado por')
print('    std::function<>(lambda_6)  dentro de  init@?A0x55c31afb.')
print('  Se acharmos o endereco de init, o codigo que faz o emplace do')
print('  _Func_impl_no_alloc esta a poucas instrucoes.')
print('  init esta no namespace anonimo ?A0x55c31afb - o nome nao da RVA.')
print('  Mas a string "?A0x55c31afb" deve existir em .rdata, e o codigo que')
print('  constroi o TypeDescriptor referencia essa string.')
print()
print('  Intervalo minimo ainda nao lido que responderia:')
print('    .rdata inteiro para achar (base+0x1f899e0) - 8.6 MB')
