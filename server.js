const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Usamos memória em vez de disco, porque serviços cloud (como o Render) apagam ficheiros temporários
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// === GERENCIADOR DE ESTADO E FILA ===
let estado_global = {
    status: 'desligado', // 'desligado' (sem robô), 'ocioso' (robô livre), 'ocupado'
    tamanho_fila: 0,
    fila_pendente: [],
    historico_respondidos: []
};

let fila_respostas = [];
let bot_socket_id = null; // Guarda a ligação exclusiva do seu servidor Python local

function notificar_todos(mensagem = null) {
    estado_global.tamanho_fila = fila_respostas.length;
    // Avisa apenas os utilizadores com o site aberto (a "sala" do frontend)
    io.to('frontend').emit('sincronizar_estado', { estado: estado_global, mensagem: mensagem });
}

// === ROTA DE RECEÇÃO DE TAREFAS (COM PDFs) ===
app.post('/api/responder', upload.fields([{ name: 'datasheet' }, { name: 'dav' }]), (req, res) => {
    try {
        if (!bot_socket_id) {
            return res.status(400).json({ status: "erro", mensagem: "O Robô local não está ligado ao servidor da nuvem!" });
        }

        const evento = req.body.evento;
        const precos = JSON.parse(req.body.precos || '[]');
        const prazos = JSON.parse(req.body.prazos || '[]');
        
        // Converte os PDFs recebidos para Base64 para enviar via WebSocket
        const ds_files = (req.files['datasheet'] || []).map(f => ({
            nome: f.originalname,
            dados_base64: f.buffer.toString('base64')
        }));
        
        const dav_files = (req.files['dav'] || []).map(f => ({
            nome: f.originalname,
            dados_base64: f.buffer.toString('base64')
        }));

        const tarefa = {
            id_tarefa: Date.now().toString(),
            evento: evento,
            precos: precos,
            prazos: prazos,
            datasheets: ds_files,
            davs: dav_files
        };

        fila_respostas.push(tarefa);
        estado_global.fila_pendente.push(evento);
        
        notificar_todos(`Evento ${evento} adicionado à fila na nuvem!`);
        
        // Se o robô estiver livre, acorda-o e envia a primeira tarefa
        if (estado_global.status === 'ocioso') {
            processar_proxima_tarefa();
        }

        res.json({ status: "sucesso" });
    } catch (error) {
        console.error("Erro na API de resposta:", error);
        res.status(500).json({ status: "erro", mensagem: error.message });
    }
});

// Função que envia a tarefa da nuvem para o Windows Server
function processar_proxima_tarefa() {
    if (fila_respostas.length > 0 && bot_socket_id) {
        const tarefa = fila_respostas.shift();
        
        // Retira dos pendentes na interface
        estado_global.fila_pendente = estado_global.fila_pendente.filter(e => e !== tarefa.evento);
        estado_global.status = 'ocupado';
        
        notificar_todos(`A enviar evento ${tarefa.evento} para o robô local...`);
        
        // Envia a missão diretamente para o Python
        io.to(bot_socket_id).emit('missao_responder', tarefa);
    }
}

// === GESTÃO DE WEBSOCKETS (FRONTEND vs ROBÔ) ===
io.on('connection', (socket) => {
    
    // O Python deve emitir 'sou_o_robo' assim que ligar
    socket.on('sou_o_robo', () => {
        bot_socket_id = socket.id;
        estado_global.status = 'ocioso';
        console.log("🤖 Robô Local Conectado ao Servidor Cloud! ID:", bot_socket_id);
        notificar_todos("Robô operacional e ligado à nuvem!");
        processar_proxima_tarefa(); // Verifica se há trabalho atrasado
    });

    // Os utilizadores que abrirem o site emitem 'sou_frontend'
    socket.on('sou_frontend', () => {
        socket.join('frontend');
        socket.emit('sincronizar_estado', { estado: estado_global, mensagem: "Sincronizado com a Nuvem." });
    });

    // Quando o robô local termina um evento, ele avisa a nuvem
    socket.on('tarefa_concluida', (dados) => {
        const { evento, sucesso, erro } = dados;
        if (sucesso) {
            estado_global.historico_respondidos.push(evento);
            notificar_todos(`Evento ${evento} concluído com sucesso pelo robô!`);
        } else {
            estado_global.historico_respondidos.push(`${evento} (Falhou)`);
            notificar_todos(`Erro do robô no evento ${evento}: ${erro}`);
        }
        
        estado_global.status = 'ocioso';
        processar_proxima_tarefa(); // Puxa a próxima da fila automaticamente
    });

    // O Python envia as imagens do Captcha
    socket.on('imagem_captcha_do_robo', (dados) => {
        io.to('frontend').emit('nova_imagem', dados);
    });

    // O Frontend envia o clique no Captcha para a Nuvem, que repassa para o Python
    socket.on('clique_no_captcha', (dados) => {
        if (bot_socket_id) {
            io.to(bot_socket_id).emit('executar_clique', dados);
            notificar_todos('A enviar clique para o servidor local...');
        }
    });

    // Comandos diretos dos botões (Ligar, Extrair, Verificar, Parar)
    socket.on('comando_direto', (dados) => {
        if (bot_socket_id) {
            io.to(bot_socket_id).emit('comando_para_robo', dados);
        }
    });

    socket.on('disconnect', () => {
        if (socket.id === bot_socket_id) {
            bot_socket_id = null;
            estado_global.status = 'desligado';
            console.log("❌ Ligação com o Robô Local perdida.");
            notificar_todos("ALERTA: O robô local foi desconectado da nuvem!");
        }
    });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`☁️ Servidor Cloud a rodar na porta ${PORT}`);
});