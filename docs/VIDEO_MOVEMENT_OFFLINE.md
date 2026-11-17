# Movimento visual offline: parada e retomada

## Escopo e estado da entrega

Fluxo independente do jogo, executado sobre arquivos. Não injeta DLL, não lê memória de processos, não envia comandos ao cliente e não importa o runtime do bot. Somente compare lê kind6, DEPOIS de congelada a anotação visual. Os arquivos existentes do bot e do tap não foram alterados.

A implementação e os contratos foram verificados com mídia sintética e cliente de API simulado. Isso NÃO comprova acurácia visual no PokeAlliance, efeito no jogo, resposta real da API ou revisão humana. O piloto real permanece bloqueado: nenhum vídeo PokeAlliance correspondente aos JSONLs foi identificado e OPENAI_API_KEY não está disponível nos escopos Process, User ou Machine. Não foram enviados vídeos pessoais de outros jogos.

## Pré-requisitos e modelo

Python 3.10+, FFmpeg e ffprobe no PATH; instalar dependência com:

    python -m pip install -r tools/video_motion/requirements.txt

Modelo padrão: gpt-5.4-mini, substituível por OPENAI_VISION_MODEL ou --model. A documentação oficial consultada em 2026-11-12 confirma entrada de imagens, Responses e saídas estruturadas. Não é necessário suporte a vídeo direto: o fluxo envia imagens PNG recortadas, em ordem, com input_image e JSON Schema em text.format.

Referências oficiais:
- https://developers.openai.com/api/docs/models/gpt-5.4-mini
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs

Disponibilize OPENAI_API_KEY no ambiente local, sem colá-la no chat, código ou logs. Alternativa: --env-file aponta para arquivo privado já existente; lê somente OPENAI_API_KEY, não outras credenciais. Nenhuma credencial é gravada nos artefatos. Apenas imagens recortadas são enviadas à API oficial; isso ainda transmite conteúdo do vídeo. store:false não é uma promessa adicional sobre retenção de dados do serviço.

## 1. Inspecionar e estabelecer rastreabilidade

    python tools/video_motion_cli.py inspect --video CAMINHO_VIDEO --out captures/motion/index.json

Registra SHA256, dimensões, duração derivada dos frames, FPS médio/nominal, time_base, PTS original de todos os frames, variação temporal, lacunas e avisos do decoder. duration_source declara se o fim usa a duração real do último frame ou uma estimativa pelo intervalo mediano; container_timing preserva a duração/início declarados pelo contêiner. timestamp_ms é PTS normalizado pelo primeiro frame; pts_ms preserva a origem. Se necessário usa best_effort_timestamp, explicitamente identificado, nunca índice/FPS como substituto. PTS não crescente bloqueia prepare. Lacunas e imagens repetidas são evidência de incerteza, não prova automática de parada.

Não usar nome, data de modificação ou proximidade de horários para declarar mesma sessão. A confirmação exige evidência do operador e três marcadores independentes que relacionem vídeo ao log. Isso só é exigido na comparação; a análise visual pode terminar sem JSONL.

## 2. Preparar piloto de 20–30 segundos

Escolha um intervalo com deslocamento visível, pelo menos dois passos normais e possíveis pausas. Use diretório de saída NOVO. Exemplo de sintaxe, com ROI MERAMENTE ILUSTRATIVA, não medida neste projeto:

    python tools/video_motion_cli.py prepare --video CAMINHO_VIDEO --out captures/motion/pilot --start-ms 0 --duration-ms 25000 --roi 100,100,640,480 --mask 500,0,140,80 --confirm-isolation

ROI: x,y,largura,altura no vídeo original. --mask pode repetir e suas coordenadas são relativas ao recorte. Máscaras são opacas. O recorte precisa mostrar personagem, piso e referências para movimento da câmera, sem holding/phase/count do Shiba. O operador deve conferir visualmente a exclusão ANTES de --confirm-isolation; o programa não consegue garantir por si só ausência de toda informação reveladora.

FFmpeg extrai TODOS os frames consecutivos do intervalo, sem conversão artificial de FPS. manifest.json preserva índice original, PTS, timestamp normalizado, caminho e hashes de arquivo/pixels para cada PNG. Uma discrepância de contagem bloqueia a extração. O envio aceita apenas esses PNGs com hash válido, nunca o vídeo bruto.

## 3. Calibrar e analisar independentemente

    python tools/video_motion_cli.py analyze --manifest captures/motion/pilot/manifest.json --out captures/motion/pilot-analysis --model gpt-5.4-mini --calibration-start-ms 0 --calibration-duration-ms 2000 --stride-ms 100 --batch-size 96 --overlap 24 --max-requests 80 --max-images 6000

O comando NÃO recebe JSONL. O prompt proíbe inferir movimento de overlays. Pede evidência de piso/câmera, separa animação do sprite, mantém oclusões/menus/cortes/transições/congelamentos indeterminados e trata texto visível como dados, não instruções. Cada imagem tem frame_id e timestamp_ms fornecidos explicitamente no TEXTO da requisição, além da tabela de frames com PTS original.

Calibração usa somente pixels e pelo menos dois intervalos normais distintos, referenciados a frames enviados. Limiar congelado ANTES da detecção: max(100 ms, ceil(1.5 * p90 observado)). --stop-min-ms permite override explícito apenas acima do p90 normal. Se a calibração não enxergar passos, o programa bloqueia; selecione outro trecho, não invente intervalo. O limiar fica em calibration.json, com modelo, evidência e regra.

A primeira passagem cobre TODO o intervalo selecionado. A amostragem padrão é 100 ms, usando PTS reais; mede o maior intervalo efetivo entre amostras. Duração mínima conservadora declarada: limiar de parada + 2 * maior intervalo entre amostras. Não é garantia de recall: eventos menores ou visualmente ambíguos podem escapar. Sobreposição mínima é ampliada conforme o limiar e a cadência original; se não couber no lote, bloqueia em vez de perder contexto silenciosamente.

Depois da cobertura completa, cada candidato, fronteira de estado ou região indeterminada recebe análise dos frames ORIGINAIS CONSECUTIVOS em torno dela. Eventos nas bordas sem contexto suficiente permanecem para revisão. Parada é datada no fim do deslocamento, não no instante posterior de confirmação. Retomada é o início do deslocamento após a permanência. Nenhum timestamp subframe é inventado.

Saídas: analysis.json, events.json, calibration.json, status.json, review.html e evidence-*.jpg. Eventos possuem event_id, event_type, earliest_ms/latest_ms, frame_before/frame_after, evidence_frames, reason e review_required; confiança é somente auxiliar. IDs inexistentes, tempos fora do lote, schema incorreto e cobertura incompleta são rejeitados. Duplicatas são consolidadas, conflitos preservados como pendências. Imagens idênticas prolongadas viram indeterminate; não provam sozinhas parada nem falha de captura.

API: timeout 90 s, uma repetição para 429/5xx por padrão; timeout de rede não é repetido automaticamente. Os limites contam tentativas e imagens, não são estimativa monetária. Limite local de payload 64 MiB: reduza ROI/lote se exceder. Cache local por hash do pedido evita chamadas iguais ao retomar; guarda resposta/uso/identificador, nunca credencial nem base64. Incompleto, recusa ou orçamento esgotado bloqueiam sem anunciar cobertura completa. Não reutilize uma pasta para outro vídeo/configuração; resultados e calibração são vinculados por hashes.

## 4. Verificar o piloto antes de expandir

Abra review.html: mostra eventos com frames de evidência e amostras de movimento contínuo, parada contínua e indeterminação quando presentes. PNGs/JPGs e HTML preservam IDs e tempos originais. Confira ROI/máscaras, fim de deslocamento, retomada e falsos eventos por animação/câmera.

Sem revisão humana, resultado continua automatic-not-human-validated. Para revisão humana independente, crie JSON com video_sha256, reviewer e events. Cada evento usa os campos obrigatórios listados acima; earliest/latest devem corresponder aos frames citados do manifesto. Indeterminate também é permitido. Depois:

    python tools/video_motion_cli.py review-human --analysis captures/motion/pilot-analysis/analysis.json --annotations CAMINHO_ANOTACOES_HUMANAS --out captures/motion/human-diff.json

Registra correspondências e eventos omitidos/extras, sem tratar o humano como infalível. O aceite precisa identificar quem verificou e quais limitações persistem:

    python tools/video_motion_cli.py accept-pilot --analysis captures/motion/pilot-analysis/analysis.json --out captures/motion/acceptance.json --reviewer OPERADOR --basis automatic-only --notes "Revisao tecnica; sem validacao humana de acuracia"

Use --basis human --human-review captures/motion/human-diff.json somente quando existir revisão humana verdadeira. automatic-only não se transforma em ground truth por ter sido aceito. Aceite preserva IDs pendentes e hashes da anotação/revisão; mudanças invalidam o vínculo.

## 5. Cobrir o vídeo completo e comparar holding

Só após a verificação do piloto:

    python tools/video_motion_cli.py prepare --video CAMINHO_VIDEO --out captures/motion/full --roi 100,100,640,480 --mask 500,0,140,80 --confirm-isolation --full-video --pilot-acceptance captures/motion/acceptance.json
    python tools/video_motion_cli.py analyze --manifest captures/motion/full/manifest.json --out captures/motion/full-analysis --model gpt-5.4-mini

Repita a ROI/máscaras REAIS do piloto, não copie as ilustrativas cegamente. O programa exige mesmo vídeo, isolamento, modelo e limiar congelado. O vídeo completo é coberto antes de refinar candidatos; orçamento insuficiente impede resultado completo, mesmo com cache parcial reutilizável.

Copie docs/examples/video-motion.session.example.json para área de captura e preencha hashes reais, evidência de mesma sessão e marcadores A/B/C. Cada marcador liga frame_index original a log_line (1-based) e t real do JSONL. Não use holding para escolher trechos ou rotular movimento. Use marcos independentes observáveis no vídeo e no registro, com incerteza documentada; não presuma sincronismo por mtime.

    python tools/video_motion_cli.py compare --analysis captures/motion/full-analysis/analysis.json --jsonl CAMINHO_JSONL --session captures/motion/session.json --out captures/motion/comparison.json

A/C ajustam relógios afins; B é validação não usada no ajuste. Resíduo permitido padrão: 33 ms, configurável de forma justificada. Drift é relatado; atraso sistemático comum aos marcadores não pode ser excluído. Não extrapola fora de A..C. Valida hashes do vídeo/log, linhas e timestamps e rejeita reset de relógio. O parser replica apenas o pequeno contrato hex UTF-8 do kind6 já usado em lure-transition-eval.cjs; não importa esse CLI porque importá-lo executaria sua rotina.

holding true->stop e false->resume só na comparação, como hipótese de referência, não rótulo visual. Primeiro estado não é transição; paused, unknown e lacunas >600 ms quebram continuidade. Transições de publicação são intervalos, não instantes visuais. Matching temporal um-a-um com tolerância padrão 1000 ms mantém eventos visuais sem par, holding sem par e eventos excluídos por incerteza. Relata intervalo assinado de atraso e não prova causalidade nem que holding seja verdade física.

## Validação local reproduzível

    $env:VIDEO_MOTION_TEST_OUTPUT = "captures/video-motion-validation"
    python tests/video_motion_checks.py
    node --test tests/video_motion.test.cjs

18 testes Python passaram em 2026-11-12; o wrapper Node também passou. Há extração real FFmpeg de fixture sintética de 25 s, 10 fps, 250 frames, PTS inicial 2000 ms, recorte e máscara conferidos; outra fixture testa VFR. O fluxo cobre piloto, refinamento, galeria, aceite, vídeo completo com calibração congelada e comparação com log SIMULADO. O cliente visual é TEST-DOUBLE-NOT-OPENAI. Os eventos programados em 5 s/9 s são respostas falsas explicitamente rotuladas, não inferência sobre o vídeo de teste.

Evidência retida da execução final: captures/video-motion-validation/synthetic-rbpaj17f/. A galeria sintética equivalente da execução synthetic-v6wlmsx_ foi inspecionada para legibilidade de índices/tempos e máscara; isso não constitui revisão humana de movimento em jogo. O bloqueio sem credencial também está registrado em synthetic-v6wlmsx_/missing-key-check/status.json (exit code 2; zero requisições).

## Pendências exatas para concluir o experimento real

1. Vídeo PokeAlliance legível e JSONL kind6 da mesma sessão (para comparação).
2. OPENAI_API_KEY utilizável, fornecida privadamente no ambiente local.
3. ROI/máscaras medidas e inspecionadas no vídeo real.
4. Trecho de calibração com passos normais e piloto de 20–30 s.
5. Três marcadores independentes vídeo/log, hashes e confirmação documentada da sessão.
6. Revisão do piloto, humana se disponível, ou classificação automática explicitamente não validada.

Não foi confirmada sessão real, não há resultado de API real e não foi medida acurácia do detector no PokeAlliance. A presença de JSONLs isolados não remove esses bloqueios.
