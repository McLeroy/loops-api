import {IUser, User} from "../../models/user";
import {createError} from "../../utils/response";
import {PasswordsService} from "../shared/passwordsService";
import {UserRole} from "../../models/enums/userRole";
import {AuthToken, IAuthToken} from "../../models/authToken";
import {sign, verify} from "jsonwebtoken";
import {config} from "../../config/config";
import {EmailVerificationService} from "./emailVerificationService";
import {AuthVerificationReason} from "../../models/enums/authVerificationReason";
import {IEmailVerification} from "../../models/emailVerification";
import {Types} from "mongoose";
import {getUpdateOptions} from "../../utils/utils";
import {DriverType, getSupportedDriverTypes} from "../../models/enums/driverType";
import {IPlatformConfiguration} from "../../models/platformConfiguration";
import {PlatformConfigurationService} from "../admins/platformConfigurationService";

export class AuthService {

    public async login(body: IUser, role: UserRole, deviceId: string): Promise<{user: IUser, token: string}> {
        if (!body.email) throw createError('Email address is required', 400);
        if (!(body as any).password) throw createError('Password is required', 400);
        let user: IUser = await User.findOne({email: body.email}).lean<IUser>().exec();
        if (!user)
            throw createError('Account does not exist', 400);
        if (!await new PasswordsService().checkPassword(user._id, (body as any).password))
            throw createError('Incorrect password', 400);
        // const update = Object.assign(AuthService.assignProfile(role, body, user), {$addToSet: {roles: role}});
        const update = await AuthService.assignProfile(role, body, user?.driverProfile?.type, user);
        user = await User.findByIdAndUpdate(user._id, update, getUpdateOptions()).lean<IUser>().exec();
        const token = await this.addAuthToken(user, role, deviceId);
        return {user, token};
    }

    public async addToRole(body: any): Promise<{user: IUser, token: string}> {
        if (!body.role) throw createError('Role is required', 400);
        if (!body.token) throw createError('Token is required', 400);
        const role = body.role;
        const token = body.token
        let user: IUser = await verify(body.token, process.env.JWT_SECRET) as IUser;
        user = await User.findByIdAndUpdate(user._id, {$addToSet: {roles: role}}, getUpdateOptions()).lean<IUser>().exec();
        return {user, token};
    }

    public async register(body: IUser, role: UserRole, deviceId: string): Promise<{user: IUser, token: string}> {
        if (!body.firstName) throw createError('First name is required', 400);
        if (!body.lastName) throw createError('Last name is required', 400);
        if (!body.email) throw createError('Email address is required', 400);
        if (!body.phone) throw createError('Phone number is required', 400);
        if (!(body as any).password) throw createError('Password is required', 400);
        if (await this.checkEmailExists(body.email))
            throw createError('Email address already in use', 400);
        if (await this.checkPhoneExists(body.phone))
            throw createError('Phone number already in use', 400);
        // TODO:: change
        const userRole = (body as any).role || role
        const type: DriverType = (body as any).type;
        body.roles = [userRole];
        // body.roles = [UserRole.DRIVER, UserRole.BASIC];
        let user: IUser = new User(await AuthService.assignProfile(role, body, type));
        await (user as any).validate();
        await new PasswordsService().addPassword(user._id, (body as any).password);
        const token = await this.addAuthToken((user as any).toObject(), role, deviceId);
        user = await (user as any).save();
        await new EmailVerificationService().requestEmailVerification(user.email, AuthVerificationReason.USER_SIGN_UP, body.phone);
        return {user, token};
    }

    public async requestEmailVerification(body: any): Promise<{message: string}> {
        if (!body.email) throw createError('Email address is required', 400);
        if (!body.reason) throw createError('Verification reason is required', 400);
        await new EmailVerificationService().requestEmailVerification(body.email, body.reason);
        return {message: 'Verification code sent'};
    }

    public async verifyEmail(body: any): Promise<{user: IUser, verificationCode: string}> {
        if (!body.email) throw createError('Email address is required', 400);
        if (!body.reason) throw createError('Verification reason is required', 400);
        if (!body.verificationCode) throw createError('Verification code is required', 400);
        const email = body.email;
        const reason: AuthVerificationReason = body.reason;
        const verificationCode = body.verificationCode;
        let user: IUser = await User.findOne({email}).lean<IUser>().exec();
        if (!user) throw createError('Account not found', 400);
        const emailVerificationService = new EmailVerificationService();
        const emailVerification: IEmailVerification = await emailVerificationService.getEmailVerification(email, reason, verificationCode, true);
        switch (reason) {
            case AuthVerificationReason.USER_SIGN_UP:
                user = await User.findByIdAndUpdate(user._id, {emailVerified: true}, {new: true}).lean<IUser>().exec();
                await emailVerificationService.removeEmailVerification(emailVerification._id);
                break;
            case AuthVerificationReason.USER_PASSWORD_RESET:
                user = null
                break;
            default:
                throw createError(`Unsupported email verification reason '${reason}'`, 400);
        }
        return {user, verificationCode};
    }

    public async requestPasswordReset(body: any): Promise<{email: string}> {
        if (!body.email) throw createError('Email address is required', 400);
        const email = body.email;
        const user: IUser = await User.findOne({email}).lean<IUser>().exec();
        if (!user)
            throw createError('Account does not exist with us', 400);
        await new EmailVerificationService().requestEmailVerification(user.email, AuthVerificationReason.USER_PASSWORD_RESET);
        return {email};
    }

    public async resetPassword(body, role: UserRole, deviceId: string): Promise<{user: IUser, token: string}> {
        if (!body.email) throw createError('Email address is required', 400);
        if (!body.verificationCode) throw createError('Verification code is required', 400);
        if (!body.password) throw createError('Password is required', 400);
        const email = body.email;
        const reason: AuthVerificationReason = AuthVerificationReason.USER_PASSWORD_RESET;
        const verificationCode = body.verificationCode;
        const emailVerificationService = new EmailVerificationService();
        const emailVerification: IEmailVerification = await emailVerificationService.getEmailVerification(email, reason, verificationCode);
        if (!emailVerification.verified) throw createError('Email not verified', 400);
        const user: IUser = await User.findOne({email}).lean<IUser>().exec();
        if (!user) throw createError('Account not found', 400);
        await new PasswordsService().addPassword(user._id, body.password);
        await emailVerificationService.removeEmailVerification(emailVerification._id);
        return await this.login({
            email: email,
            password: body.password
        } as any, role, deviceId);
    }

    // noinspection JSMethodCanBeStatic
    private async addAuthToken(user: IUser, role: UserRole, deviceId: string): Promise<string> {
        const userId: string = user._id;
        const token = AuthService.generateToken(user);
        const authToken: IAuthToken = await AuthToken.findOneAndUpdate({userId, role, deviceId}, {
            deviceId, token
        }, {runValidators: true, setDefaultsOnInsert: true, upsert: true, new: true}).lean<IAuthToken>().exec();
        return authToken.token;
    }

    // noinspection JSMethodCanBeStatic
    private async removeAllTokensForUser(user: IUser) {
        const userId: string = user._id;
        await AuthToken.deleteMany({userId}).exec();
    }

    public async verifyToken(userId: string, token: string, deviceId: string): Promise<IAuthToken> {
        console.log(`Verifying token. User: ${userId}, deviceId: ${deviceId}`);
        return await AuthToken.findOne({userId, deviceId, token}).lean<IAuthToken>().exec();
    }

    public async getAuthToken(token: string, deviceId: string, validate = true): Promise<IAuthToken> {
        const authToken: IAuthToken = await AuthToken.findOne({token, deviceId}).lean<IAuthToken>().exec();
        if (!authToken && validate) throw createError('Auth token not found', 400);
        return authToken;
    }

    // noinspection JSMethodCanBeStatic
    private async checkEmailExists(email: string): Promise<boolean> {
        const count = await User.countDocuments({email}).exec();
        return count > 0;
    }

    // noinspection JSMethodCanBeStatic
    private async checkPhoneExists(phone: string): Promise<boolean> {
        const count = await User.countDocuments({phone}).exec();
        return count > 0;
    }

    private static generateToken(user: IUser): string {
        return sign(user, config.jwtSecret);
    }

    private static async assignProfile(role: UserRole, body: any, type: DriverType, existingUser?: IUser): Promise<any> {
        const platformConfiguration: IPlatformConfiguration = await PlatformConfigurationService.getPlatformConfigurations();
        if (role === UserRole.DRIVER) {
            if (!getSupportedDriverTypes().includes(type))
                throw createError(`Unknown driver type: ${type}`, 400)
            if (!platformConfiguration.allowNewDriverSignUp && !existingUser)
                throw createError('New driver sign up is temporarily suspended', 400);
            return Object.assign(body, {
                driverProfile: existingUser?.driverProfile || {
                    _id: Types.ObjectId(),
                    message: 'Document not uploaded',
                    enabled: false,
                    totalRating: 0,
                    averageRating: 5,
                    type: type
                }
            });
        } else {
            if (!platformConfiguration.allowNewUserSignUp) throw createError('New user sign up is temporarily suspended', 400);
            return  Object.assign(body, {
                userProfile: existingUser?.userProfile || {
                    _id: Types.ObjectId(),
                    message: null,
                    enabled: false,
                    totalRating: 0,
                    averageRating: 5
                }
            });
        }
    }
}
