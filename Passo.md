🚀 Passo a passo rápido para subir no Supabase + Render:

No Supabase:

Crie um projeto gratuito e vá em Project Settings → Database → Connection string (URI).
Copie a URI (ex: Session Pooler na porta 5432 ou conexão direta) e substitua [YOUR-PASSWORD] pela senha do banco.

No Render (Backend - Web Service):

Conecte seu repositório GitHub, defina Root Directory como backend.
Build Command: npm install && npm run build
Start Command: npm run start:deploy (já cria as tabelas no Supabase automaticamente na primeira inicialização!).
Adicione as variáveis de ambiente:
DATABASE_URL: A URL do seu Supabase
FRONTEND_URL: A URL do seu frontend no Render (ex: https://meu-9drive.onrender.com)
JWT_ACCESS_SECRET: Uma chave aleatória de 32+ caracteres
TOKEN_ENCRYPTION_KEY: Outra chave aleatória de 32+ caracteres
ALLOW_REGISTRATION: false (permite apenas o primeiro cadastro — o seu — e bloqueia desconhecidos)

No Render (Frontend - Static Site):

Conecte o mesmo repositório, defina Root Directory como frontend.
Build Command: npm install && npm run build
Publish Directory: dist
Variável de ambiente: VITE_API_URL = URL do seu backend no Render (ex: https://meu-9drive-backend.onrender.com).
Em Redirects/Rewrites, adicione: Source /* → Destination /index.html → Action Rewrite.