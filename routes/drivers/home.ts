import {Router} from "express";
import {reqAsAny} from "../../utils/utils";
import {sendError, sendResponse} from "../../utils/response";
import {HomeService} from "../../services/drivers/homeService";
const app = Router();

app.get('/', (req, res, next) => {
    new HomeService().loadHome(reqAsAny(req).query.userId).then(result => {
        sendResponse(res, 200, result);
    }).catch(err => {
        sendError(err, next);
    });
});

module.exports = app;
