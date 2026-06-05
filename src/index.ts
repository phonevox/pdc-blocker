import 'dotenv/config'
import fs from 'node:fs'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import type { ChatInputCommandInteraction } from 'discord.js'

function b64url(data: ArrayBuffer | string): string {
    const bytes =
        typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array(data)
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

async function generateHmacJwt(secret: string): Promise<string> {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const now = Math.floor(Date.now() / 1000)
    const payload = b64url(JSON.stringify({ iat: now, exp: now + 60 }))
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )
    const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${header}.${payload}`)
    )
    return `${header}.${payload}.${b64url(sig)}`
}

/*
  Estrutura esperada no commands.json.
*/
type CommandJson = {
    name: string
    description: string
    response: string
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const BLOCKER_ENDPOINT = process.env.BLOCKER_ENDPOINT
const JWT_TOKEN = process.env.JWT_TOKEN

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN não definido no .env')
if (!BLOCKER_ENDPOINT) throw new Error('BLOCKER_ENDPOINT não definido no .env')
if (!JWT_TOKEN) throw new Error('JWT_TOKEN não definido no .env')

/*
  Carrega o JSON uma vez na inicialização.
*/
const rawJson = fs.readFileSync('./commands.json', 'utf-8')
const commandsJson = JSON.parse(rawJson) as CommandJson[]

if (!Array.isArray(commandsJson)) {
    throw new Error('commands.json inválido: o conteúdo deve ser um array')
}

const MENTION_PATTERN = /@(everyone|here)/i

for (const cmd of commandsJson) {
    if (!cmd.name || !cmd.description || !cmd.response) {
        throw new Error(
            'commands.json inválido: todo comando precisa ter name, description e response'
        )
    }
    if (MENTION_PATTERN.test(cmd.response)) {
        throw new Error(
            `commands.json inválido: o comando "${cmd.name}" contém @everyone ou @here na resposta`
        )
    }
}

/*
  Nomes reservados para comandos fixos.
*/
const RESERVED_COMMANDS = ['help', 'atualizar-bloqueador']

for (const reserved of RESERVED_COMMANDS) {
    if (commandsJson.some((cmd) => cmd.name === reserved)) {
        throw new Error(
            `commands.json inválido: o comando "${reserved}" é reservado e deve ser tratado separadamente`
        )
    }
}

/*
  Mapa para buscar o comando pelo nome rapidamente.
*/
const commandsMap = new Map<string, CommandJson>()

for (const cmd of commandsJson) {
    commandsMap.set(cmd.name, cmd)
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
})

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`)
})

client.on(Events.InteractionCreate, async (interaction) => {
    /*
      Ignora tudo que não for slash command.
    */
    if (!interaction.isChatInputCommand()) return

    await handleSlashCommand(interaction)
})

async function handleSlashCommand(
    interaction: ChatInputCommandInteraction
): Promise<void> {
    console.log({
        type: 'SLASH_COMMAND',
        command: interaction.commandName,
        user: interaction.user.tag,
        userId: interaction.user.id,
        guild: interaction.guild?.name,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        timestamp: new Date().toISOString(),
    })

    /*
      BLOQUEIO DE CANAL
      Define os canais permitidos via .env
      Ex: ALLOWED_CHANNELS=123,456
    */
    const allowedChannels = (process.env.ALLOWED_CHANNELS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)

    /*
      Se houver canais definidos e o atual não estiver na lista → bloqueia.
    */
    if (
        allowedChannels.length > 0 &&
        !allowedChannels.includes(interaction.channelId)
    ) {
        await interaction.reply({
            content: 'Este comando só pode ser usado no canal configurado.',
            flags: 64,
        })
        return
    }

    try {
        /*
          /atualizar-bloqueador: chama o endpoint e anuncia publicamente o resultado.
        */
        if (interaction.commandName === 'atualizar-bloqueador') {
            // Defer público — a mensagem editada ficará visível para todos no canal
            await interaction.deferReply()

            try {
                const token = await generateHmacJwt(JWT_TOKEN!)

                console.log({
                    type: 'BLOCKER_REQUEST',
                    url: BLOCKER_ENDPOINT,
                    method: 'POST',
                    user: interaction.user.tag,
                    userId: interaction.user.id,
                    timestamp: new Date().toISOString(),
                })

                const abort = new AbortController()
                const timeout = setTimeout(() => abort.abort(), 60_000)

                const res = await fetch(BLOCKER_ENDPOINT!, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                    signal: abort.signal,
                })
                clearTimeout(timeout)

                const body = await res.text()
                console.log({
                    type: 'BLOCKER_RESPONSE',
                    url: endpoint,
                    status: res.status,
                    ok: res.ok,
                    body,
                    user: interaction.user.tag,
                    timestamp: new Date().toISOString(),
                })

                if (!res.ok) {
                    await interaction.editReply(
                        `Falha ao atualizar o bloqueador. Status: ${res.status}`
                    )
                    return
                }

                await interaction.editReply(
                    `Bloqueador atualizado com sucesso! (solicitado por ${interaction.user})`
                )
            } catch (err) {
                console.error('Erro ao chamar BLOCKER_ENDPOINT:', err)
                await interaction.editReply(
                    'Erro ao conectar com o endpoint do bloqueador.'
                )
            }

            return
        }

        /*
          Comando /help separado:
          monta a lista com base em todos os comandos do commands.json.
        */
        if (interaction.commandName === 'help') {
            const helpMessage = commandsJson
                .map((cmd) => `/${cmd.name} - ${cmd.description}`)
                .join('\n')

            await interaction.reply({
                content:
                    helpMessage.length > 0
                        ? `Comandos disponíveis:\n\n${helpMessage}`
                        : 'Nenhum comando disponível no momento.',
                flags: 64,
            })
            return
        }

        /*
          Procura o comando dinâmico no JSON.
        */
        const command = commandsMap.get(interaction.commandName)

        /*
          Se não existir, responde para o Discord não ficar pendurado.
        */
        if (!command) {
            await interaction.reply({
                content: 'Comando não encontrado.',
                flags: 64,
            })
            return
        }

        /*
          Resposta dinâmica vinda do JSON.
        */
        await interaction.reply({
            content: command.response,
            flags: 64,
        })
    } catch (error) {
        console.error('Erro ao processar interação:', error)

        /*
          Garante que o Discord sempre receba alguma resposta.
        */
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: 'Ocorreu um erro ao executar o comando.',
                flags: 64,
            })
        } else {
            await interaction.reply({
                content: 'Ocorreu um erro ao executar o comando.',
                flags: 64,
            })
        }
    }
}

client.login(DISCORD_TOKEN)