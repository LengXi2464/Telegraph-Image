import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();
        const fileSize = uploadFile.size;
        
        console.log(`Uploading file: ${fileName}, size: ${fileSize} bytes, type: ${uploadFile.type}`);

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);
        
        // 为了支持无限制上传，默认使用document方式上传所有文件
        // 这样可以避免图片和其他媒体类型的大小限制
        telegramFormData.append("document", uploadFile);
        let apiEndpoint = 'sendDocument';
        
        // 记录上传方式
        console.log(`Using ${apiEndpoint} for upload`);

        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${fileId}.${fileExtension}` }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    // 增加重试次数以提高大文件上传成功率
    const MAX_RETRIES = 5;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        // 使用更长的超时时间并优化请求配置以支持大文件
        const response = await fetch(apiUrl, {
            method: "POST",
            body: formData,
            // 允许更大的内容长度
            headers: {
                'Content-Type': 'multipart/form-data'
            },
            // 确保不会因为超时中断上传
            signal: AbortSignal.timeout(60000 * (retryCount + 1)) // 每次重试增加超时时间
        });
        
        const responseData = await response.json();
        console.log(`Telegram API response: ${JSON.stringify(responseData)}`);

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 记录错误信息
        console.error(`Upload error: ${responseData.description || 'Unknown error'}`);

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error(`Network error (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);
        
        if (retryCount < MAX_RETRIES) {
            // 增加重试间隔，避免频繁请求
            const delay = 2000 * Math.pow(2, retryCount); // 指数退避策略
            console.log(`Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        
        return { success: false, error: `Network error occurred after ${MAX_RETRIES} attempts` };
    }
}
