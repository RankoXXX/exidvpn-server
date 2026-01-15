import express from 'express';
import cors from 'cors';
import { PublicKey, Connection, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PrivacyCash } from 'privacycash';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bs58 from 'bs58';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 8080;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PAYMENT_WALLET = process.env.PAYMENT_WALLET;
const PAYMENT_AMOUNT = parseInt(process.env.PAYMENT_AMOUNT || '1000000'); // 1 USDC
const DVPN_API_URL = process.env.DVPN_API_URL || 'https://api.dvpnsdk.com';
const DVPN_APP_TOKEN = process.env.DVPN_APP_TOKEN;
const DESKTOP_SCHEME = process.env.DESKTOP_SCHEME || 'exidvpn';

// USDC Mint
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// SOL amount user needs to send to burner for Privacy Cash operations
const BURNER_SOL_REQUIRED = 0.003 * 1_000_000_000; // 0.003 SOL in lamports

// Solana connection
const connection = new Connection(RPC_URL, 'confirmed');

// Active sessions (in production, use Redis or database)
const sessions = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'static')));

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', service: 'exid-vpn-backend' });
});

// Get payment info
app.get('/api/payment-info', (req, res) => {
    res.json({
        success: true,
        data: {
            wallet: PAYMENT_WALLET,
            amount: PAYMENT_AMOUNT,
            amount_human: PAYMENT_AMOUNT / 1_000_000,
            token: 'USDC',
            mint: USDC_MINT.toString(),
            network: 'solana',
            burnerSolRequired: BURNER_SOL_REQUIRED,
            burnerSolHuman: BURNER_SOL_REQUIRED / 1_000_000_000
        }
    });
});

// Get recent blockhash
app.get('/api/blockhash', async (req, res) => {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        res.json({ success: true, blockhash, lastValidBlockHeight });
    } catch (error) {
        console.error('Failed to get blockhash:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a new payment session - just generates burner, user funds it
app.post('/api/create-session', async (req, res) => {
    try {
        // Generate burner keypair
        const burnerKeypair = Keypair.generate();
        const burnerPublicKey = burnerKeypair.publicKey;

        console.log('Creating session with burner:', burnerPublicKey.toString());

        // Get burner's USDC ATA address
        const burnerATA = await getAssociatedTokenAddress(
            USDC_MINT,
            burnerPublicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Generate session ID
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store session (with 15 minute expiry)
        sessions.set(sessionId, {
            burnerKeypair,
            burnerPublicKey: burnerPublicKey.toString(),
            burnerATA: burnerATA.toString(),
            // Store private key as base58 for Privacy Cash SDK
            burnerPrivateKeyBase58: bs58.encode(burnerKeypair.secretKey),
            createdAt: Date.now(),
            expiresAt: Date.now() + 15 * 60 * 1000
        });

        // Clean up old sessions
        for (const [id, session] of sessions.entries()) {
            if (Date.now() > session.expiresAt) {
                sessions.delete(id);
            }
        }

        res.json({
            success: true,
            sessionId,
            burnerAddress: burnerPublicKey.toString(),
            burnerATA: burnerATA.toString(),
            usdcAmount: PAYMENT_AMOUNT,
            usdcAmountHuman: PAYMENT_AMOUNT / 1_000_000,
            solRequired: BURNER_SOL_REQUIRED,
            solRequiredHuman: BURNER_SOL_REQUIRED / 1_000_000_000
        });

    } catch (error) {
        console.error('Failed to create session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Execute Privacy Cash transaction using session
app.post('/api/execute-privacy-transaction', async (req, res) => {
    try {
        const { sessionId, fundingTxSignature } = req.body;

        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId is required' });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(400).json({ success: false, error: 'Invalid or expired session' });
        }

        console.log('Executing privacy transaction for session:', sessionId);

        // Wait for user's funding transaction to confirm
        if (fundingTxSignature) {
            console.log('Waiting for funding transaction:', fundingTxSignature);

            let confirmed = false;
            for (let attempt = 0; attempt < 30; attempt++) {
                try {
                    const status = await connection.getSignatureStatus(fundingTxSignature);
                    if (status?.value?.confirmationStatus === 'confirmed' ||
                        status?.value?.confirmationStatus === 'finalized') {
                        if (!status.value.err) {
                            confirmed = true;
                            console.log('Funding transaction confirmed!');
                            break;
                        } else {
                            throw new Error('Funding transaction failed on-chain');
                        }
                    }
                } catch (e) {
                    if (e.message.includes('failed on-chain')) throw e;
                }
                await new Promise(r => setTimeout(r, 1000));
            }

            if (!confirmed) {
                throw new Error('Funding transaction did not confirm within 30 seconds');
            }
        }

        // Verify burner has USDC
        const burnerATA = new PublicKey(session.burnerATA);

        let usdcBalance = 0;
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const accountInfo = await connection.getTokenAccountBalance(burnerATA);
                usdcBalance = parseInt(accountInfo.value.amount);
                console.log('Burner USDC balance:', usdcBalance);
                if (usdcBalance >= PAYMENT_AMOUNT) break;
            } catch (e) {
                console.log(`Balance check attempt ${attempt + 1}:`, e.message);
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (usdcBalance < PAYMENT_AMOUNT) {
            throw new Error(`Insufficient USDC. Have: ${usdcBalance}, Need: ${PAYMENT_AMOUNT}`);
        }

        // Initialize Privacy Cash client with burner keypair
        console.log('Initializing Privacy Cash client...');
        const client = new PrivacyCash({
            RPC_url: RPC_URL,
            owner: session.burnerPrivateKeyBase58
        });

        // Deposit USDC to Privacy Pool
        console.log('Depositing USDC to Privacy Pool...');
        const depositResult = await client.depositSPL({
            amount: PAYMENT_AMOUNT / 1_000_000,
            mintAddress: USDC_MINT
        });
        console.log('Deposit successful:', depositResult.signature);

        // Wait a bit for deposit to process
        await new Promise(r => setTimeout(r, 3000));

        // Withdraw from Privacy Pool to Payment Wallet
        console.log(`Withdrawing to payment wallet: ${PAYMENT_WALLET}`);
        const withdrawResult = await client.withdrawSPL({
            mintAddress: USDC_MINT,
            amount: PAYMENT_AMOUNT / 1_000_000,
            recipientAddress: PAYMENT_WALLET
        });
        console.log('Withdrawal successful:', withdrawResult.signature);

        // Create device via DVPN SDK
        console.log('Creating device...');
        const deviceResponse = await fetch(`${DVPN_API_URL}/device`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platform: 'WINDOWS',
                app_token: DVPN_APP_TOKEN
            })
        });

        if (!deviceResponse.ok) {
            const error = await deviceResponse.text();
            console.error('DVPN API error:', error);
            throw new Error('Failed to create device');
        }

        const deviceData = await deviceResponse.json();
        const deviceToken = deviceData.data?.token;
        const deviceId = deviceData.data?.id;

        if (!deviceToken) {
            throw new Error('No device token received');
        }

        // Generate deep link
        const deepLink = `${DESKTOP_SCHEME}://activate?token=${deviceToken}`;

        // Clean up session
        sessions.delete(sessionId);

        console.log('Payment complete! Device:', deviceId);

        res.json({
            success: true,
            device_id: deviceId,
            device_token: deviceToken,
            deep_link: deepLink,
            withdrawal_tx: withdrawResult.signature
        });

    } catch (error) {
        console.error('Privacy transaction error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Proxy transaction submission
app.post('/api/send-transaction', async (req, res) => {
    try {
        const { signedTransaction } = req.body;

        if (!signedTransaction) {
            return res.status(400).json({ success: false, error: 'signedTransaction required' });
        }

        console.log('Proxying transaction submission...');

        let txBuffer;
        if (Array.isArray(signedTransaction)) {
            txBuffer = Buffer.from(signedTransaction);
        } else if (typeof signedTransaction === 'string') {
            txBuffer = Buffer.from(signedTransaction, 'base64');
        } else {
            txBuffer = Buffer.from(Object.values(signedTransaction));
        }

        const signature = await connection.sendRawTransaction(txBuffer, {
            skipPreflight: false,
            maxRetries: 3
        });

        console.log('Transaction submitted:', signature);
        res.json({ success: true, signature });

    } catch (error) {
        console.error('Failed to send transaction:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Catch-all for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Payment wallet: ${PAYMENT_WALLET}`);
    console.log(`Payment amount: ${PAYMENT_AMOUNT} (${PAYMENT_AMOUNT / 1_000_000} USDC)`);
    console.log(`Burner SOL required: ${BURNER_SOL_REQUIRED} (${BURNER_SOL_REQUIRED / 1_000_000_000} SOL)`);
    console.log(`RPC URL: ${RPC_URL}`);
});
