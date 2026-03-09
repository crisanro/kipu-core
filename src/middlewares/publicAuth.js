const publicAuth = (req, res, next) => {
    // 1. Obtener el origen de la petición
    const origin = req.get('origin') || req.get('referer');
    
    // 2. Definir dominios permitidos (puedes añadir localhost para tus pruebas)
    const allowedDomains = ['kipu.ec', 'www.kipu.ec'];
    
    // Si estás en desarrollo, puedes descomentar la siguiente línea:
    // if (process.env.NODE_ENV === 'development') return next();

    if (!origin) {
        return res.status(403).json({ 
            error: 'Acceso denegado', 
            message: 'No se detectó el origen de la petición.' 
        });
    }

    // 3. Validar si el origen coincide con tus dominios
    const isAllowed = allowedDomains.some(domain => origin.includes(domain));

    if (isAllowed) {
        next();
    } else {
        res.status(403).json({ 
            error: 'Dominio no autorizado', 
            message: 'Esta consulta solo está permitida desde el sitio oficial de Kipu.' 
        });
    }
};

module.exports = publicAuth;
